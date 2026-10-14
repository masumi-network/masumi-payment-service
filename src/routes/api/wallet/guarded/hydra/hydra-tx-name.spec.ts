import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Network } from '@/generated/prisma/client';

type Metadata = Array<{ label: string; json_metadata: unknown }>;
type Input = {
	tx_hash: string;
	collateral?: boolean;
	reference?: boolean;
	amount: Array<{ unit: string; quantity: string }>;
};
const mockTxsMetadata = jest.fn<(hash: string) => Promise<Metadata>>();
const mockTxsUtxos = jest.fn<(hash: string) => Promise<{ inputs: Input[] }>>();
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ txsMetadata: mockTxsMetadata, txsUtxos: mockTxsUtxos }),
}));

const { findWalletHydraExit } = await import('./hydra-tx-name');

const TOKEN = `${'p'.repeat(56)}${'s'.repeat(64)}`;
const named = (name: string): Metadata => [{ label: '55555', json_metadata: name }];
const walletInput = (txHash: string): Input => ({ tx_hash: txHash, amount: [{ unit: TOKEN, quantity: '1' }] });

/** A chain of txs, newest first: each entry is the tx's metadata and its inputs. */
function chain(txs: Record<string, { metadata: Metadata; inputs?: Input[] }>) {
	mockTxsMetadata.mockImplementation(async (hash) => txs[hash].metadata);
	mockTxsUtxos.mockImplementation(async (hash) => ({ inputs: txs[hash].inputs ?? [] }));
}

const find = () =>
	findWalletHydraExit({ network: Network.Preprod, rpcApiKey: 'key', utxoTxHash: 'tx-0', stateTokenUnit: TOKEN });

beforeEach(() => {
	jest.clearAllMocks();
});

describe('findWalletHydraExit', () => {
	it.each(['HydraV2/FanoutTx', 'HydraV2/PartialFanoutTx', 'HydraV2/FinalPartialFanoutTx'])(
		'reads %s as a fanout',
		async (name) => {
			chain({ 'tx-0': { metadata: named(name) } });
			await expect(find()).resolves.toBe('fanout');
		},
	);

	it('reads a decrement as the exit a withdraw makes', async () => {
		chain({ 'tx-0': { metadata: named('HydraV2/DecrementTx') } });
		await expect(find()).resolves.toBe('decrement');
	});

	// A fanout, then an agent purchase on L1: the purchase must not hide the fanout.
	it('walks back through later wallet spends to the exit', async () => {
		chain({
			'tx-0': {
				metadata: [{ label: '674', json_metadata: 'purchase' }],
				inputs: [
					{ tx_hash: 'fee', amount: [{ unit: 'lovelace', quantity: '9' }] },
					{ tx_hash: 'collateral', collateral: true, amount: [{ unit: TOKEN, quantity: '1' }] },
					{ tx_hash: 'reference', reference: true, amount: [{ unit: TOKEN, quantity: '1' }] },
					walletInput('tx-1'),
				],
			},
			'tx-1': { metadata: [], inputs: [walletInput('tx-2')] },
			'tx-2': { metadata: named('HydraV2/FanoutTx') },
		});
		await expect(find()).resolves.toBe('fanout');
		expect(mockTxsMetadata.mock.calls.map(([hash]) => hash)).toEqual(['tx-0', 'tx-1', 'tx-2']);
	});

	it('finds no exit when another hydra tx or the mint comes first', async () => {
		chain({ 'tx-0': { metadata: named('HydraV2/RecoverTx') } });
		await expect(find()).resolves.toBe('none');
		chain({ 'tx-0': { metadata: [], inputs: [{ tx_hash: 'seed', amount: [{ unit: 'lovelace', quantity: '1' }] }] } });
		await expect(find()).resolves.toBe('none');
	});

	it('gives up after a bounded walk', async () => {
		mockTxsMetadata.mockResolvedValue([]);
		mockTxsUtxos.mockImplementation(async (hash) => ({ inputs: [walletInput(`${hash}'`)] }));
		await expect(find()).resolves.toBe('unknown');
		expect(mockTxsMetadata).toHaveBeenCalledTimes(20);
	});

	it('throws when a lookup fails', async () => {
		mockTxsMetadata.mockRejectedValue(new Error('down'));
		await expect(find()).rejects.toThrow('down');
	});
});
