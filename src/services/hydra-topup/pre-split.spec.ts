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

	it('throws when no output matches the exact amount', async () => {
		const params = baseParams({
			blockchainProvider: { fetchUTxOs: jest.fn(async () => [carvedUtxo('lovelace', '49999999')]) } as any,
		});
		await expect(carveExactUtxo(params)).rejects.toThrow('not found');
	});
});
