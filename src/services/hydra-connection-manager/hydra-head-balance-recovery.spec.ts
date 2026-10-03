import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';

const address = 'wallet-address';
const splitHash = 'a'.repeat(64);
const depositHash = 'b'.repeat(64);
const originalHash = 'c'.repeat(64);
const findHead = jest.fn<() => Promise<object | null>>();
const findRecovered = jest.fn<() => Promise<Array<{ depositTxHash: string | null; splitTxHash: string | null }>>>();
const fetchUtxos = jest.fn<() => Promise<UTxO[]>>();
type ChainInput = { address: string; tx_hash: string; output_index: number; collateral?: boolean; reference?: boolean };
const txsUtxos = jest.fn<(hash: string) => Promise<{ inputs: ChainInput[] }>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: findHead }, hydraTopup: { findMany: findRecovered } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { warn: jest.fn() } }));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ txsUtxos }),
}));
jest.unstable_mockModule('./hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getProvider: () => ({ fetchAddressUTxOs: fetchUtxos }) }),
}));

const { getOwnInHeadBalance } = await import('./hydra-head-balance');

function utxo(txHash: string, outputIndex: number): UTxO {
	return { input: { txHash, outputIndex }, output: { address, amount: [{ unit: 'lovelace', quantity: '9000000' }] } };
}

beforeEach(() => {
	jest.clearAllMocks();
	findHead.mockResolvedValue({
		id: 'head',
		LocalParticipant: {
			Wallet: {
				walletAddress: address,
				PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'test-key' } },
			},
		},
	});
	findRecovered.mockResolvedValue([{ depositTxHash: depositHash, splitTxHash: splitHash }]);
	txsUtxos.mockResolvedValue({ inputs: [{ address, tx_hash: splitHash, output_index: 0 }] });
});

describe('recovered deposit balance', () => {
	it('keeps a backed sibling change output out of the unbacked balance', async () => {
		fetchUtxos.mockResolvedValue([utxo(splitHash, 1)]);
		expect(await getOwnInHeadBalance('head')).toMatchObject({ unbackedLovelace: '0', hasUnbackedUtxos: false });
	});

	it('identifies the exact recovered input without labelling its sibling', async () => {
		fetchUtxos.mockResolvedValue([utxo(splitHash, 0), utxo(splitHash, 1)]);
		expect(await getOwnInHeadBalance('head')).toMatchObject({ unbackedLovelace: '9000000', hasUnbackedUtxos: true });
	});

	it('identifies recovered whole-UTxO deposits without a split transaction', async () => {
		findRecovered.mockResolvedValue([{ depositTxHash: depositHash, splitTxHash: null }]);
		txsUtxos.mockResolvedValue({ inputs: [{ address, tx_hash: originalHash, output_index: 2 }] });
		fetchUtxos.mockResolvedValue([utxo(originalHash, 2)]);
		expect(await getOwnInHeadBalance('head')).toMatchObject({ unbackedLovelace: '9000000', hasUnbackedUtxos: true });
	});

	it('excludes collateral and reference inputs, which were not committed', async () => {
		txsUtxos.mockResolvedValue({
			inputs: [
				{ address, tx_hash: originalHash, output_index: 0, collateral: true },
				{ address, tx_hash: originalHash, output_index: 1, reference: true },
				{ address: 'node-address', tx_hash: originalHash, output_index: 2 },
			],
		});
		fetchUtxos.mockResolvedValue([utxo(originalHash, 0), utxo(originalHash, 1), utxo(originalHash, 2)]);
		expect(await getOwnInHeadBalance('head')).toMatchObject({ unbackedLovelace: '0', hasUnbackedUtxos: false });
	});

	it('reports an unavailable recovery check instead of a clean balance', async () => {
		txsUtxos.mockRejectedValueOnce(new Error('chain unavailable'));
		fetchUtxos.mockResolvedValue([utxo(originalHash, 2)]);
		await expect(getOwnInHeadBalance('head')).rejects.toMatchObject({ status: 502 });
	});
});
