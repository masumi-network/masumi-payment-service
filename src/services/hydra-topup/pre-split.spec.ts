import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockLookupConfirmedChainTx = jest.fn() as AnyMock;

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupConfirmedChainTx: mockLookupConfirmedChainTx,
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Transaction is only referenced by the default submit path, which the tests
// override via submitCarveTx — stub the export so importing the module is safe.
jest.unstable_mockModule('@meshsdk/core', () => ({
	Transaction: class {
		sendLovelace() {
			return this;
		}
		sendAssets() {
			return this;
		}
		build() {
			return Promise.resolve('cbor');
		}
	},
}));

let carveExactUtxo: typeof import('./pre-split').carveExactUtxo;
let HydraPreSplitError: typeof import('./pre-split').HydraPreSplitError;

beforeAll(async () => {
	({ carveExactUtxo, HydraPreSplitError } = await import('./pre-split'));
});

const ADDR = 'addr_test1participant';
const TX = 'a'.repeat(64);

function carvedUtxo(unit: string, quantity: string, index = 0) {
	const amount =
		unit === 'lovelace'
			? [{ unit: 'lovelace', quantity }]
			: [
					{ unit: 'lovelace', quantity: '1500000' },
					{ unit, quantity },
				];
	return { input: { txHash: TX, outputIndex: index }, output: { address: ADDR, amount } };
}

function baseParams(overrides: Record<string, unknown> = {}) {
	return {
		wallet: {} as any,
		blockchainProvider: { fetchUTxOs: jest.fn(async () => [carvedUtxo('lovelace', '50000000')]) } as any,
		walletAddress: ADDR,
		unit: 'lovelace',
		amount: 50_000_000n,
		network: 'Preprod' as const,
		rpcProviderApiKey: 'key',
		now: () => 0,
		sleep: async () => {},
		submitCarveTx: jest.fn(async () => TX) as AnyMock,
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockLookupConfirmedChainTx.mockResolvedValue('confirmed-valid');
});

describe('carveExactUtxo', () => {
	it('submits, waits for confirmation, and returns the exact-amount UTxO', async () => {
		const params = baseParams();
		const result = await carveExactUtxo(params);
		expect(result.output.amount).toEqual([{ unit: 'lovelace', quantity: '50000000' }]);
		expect(params.submitCarveTx as AnyMock).toHaveBeenCalledWith(params.wallet, ADDR, 'lovelace', 50_000_000n);
	});

	it('rejects a non-positive amount', async () => {
		await expect(carveExactUtxo(baseParams({ amount: 0n }))).rejects.toBeInstanceOf(HydraPreSplitError);
	});

	it('throws when the carve tx is invalid on-chain', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('confirmed-invalid');
		await expect(carveExactUtxo(baseParams())).rejects.toThrow('was invalid on-chain');
	});

	it('times out (funds remain in wallet) if never confirmed', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('pending');
		let t = 0;
		const params = baseParams({ now: () => (t += 60_000) });
		await expect(carveExactUtxo(params)).rejects.toThrow('did not confirm within the timeout');
	});

	it('polls until confirmation', async () => {
		mockLookupConfirmedChainTx.mockResolvedValueOnce('pending').mockResolvedValueOnce('confirmed-valid');
		const params = baseParams();
		await carveExactUtxo(params);
		expect(mockLookupConfirmedChainTx).toHaveBeenCalledTimes(2);
	});

	it('carves an exact token amount (min-ADA output ignored for the match)', async () => {
		const unit = 'dd'.repeat(28) + '0014df10';
		const params = baseParams({
			unit,
			amount: 750n,
			blockchainProvider: { fetchUTxOs: jest.fn(async () => [carvedUtxo(unit, '750')]) } as any,
		});
		const result = await carveExactUtxo(params);
		expect(result.output.amount.find((a: any) => a.unit === unit)?.quantity).toBe('750');
	});

	// A carve is an L1 self-payment: the deposit that follows it can fail with the
	// money already split off. Carving again then cost a second fee and left the
	// first dedicated UTxO in the wallet with nothing pointing at it.
	it('reuses an exact UTxO the wallet already holds instead of carving another', async () => {
		const already = carvedUtxo('lovelace', '50000000', 3);
		const params = baseParams({ existingUtxos: [carvedUtxo('lovelace', '49999999', 1), already] });

		const result = await carveExactUtxo(params);

		expect(result).toBe(already);
		expect(params.submitCarveTx as AnyMock).not.toHaveBeenCalled();
		expect(mockLookupConfirmedChainTx).not.toHaveBeenCalled();
	});

	// The reuse must be as strict as the match on a carve's own outputs: a UTxO
	// of the right lovelace amount that also carries tokens is not a carve, and
	// committing it would put an agent's registry NFT inside the head.
	it('does not reuse a UTxO that carries other assets', async () => {
		const withToken = {
			input: { txHash: TX, outputIndex: 7 },
			output: {
				address: ADDR,
				amount: [
					{ unit: 'lovelace', quantity: '50000000' },
					{ unit: 'ff'.repeat(28) + '4e4654', quantity: '1' },
				],
			},
		};
		const params = baseParams({ existingUtxos: [withToken] });

		const result = await carveExactUtxo(params);

		expect(result).not.toBe(withToken);
		expect(params.submitCarveTx as AnyMock).toHaveBeenCalledTimes(1);
	});

	it('throws when no output matches the exact amount', async () => {
		const params = baseParams({
			blockchainProvider: { fetchUTxOs: jest.fn(async () => [carvedUtxo('lovelace', '49999999')]) } as any,
		});
		await expect(carveExactUtxo(params)).rejects.toThrow('not found');
	});
});
