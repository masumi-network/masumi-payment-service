import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { Network } from '@/generated/prisma/client';

type TxDetails = {
	hash: string;
	block: string;
	valid_contract: boolean;
};

type BlockDetails = {
	confirmations: number;
};

const mockTxs = jest.fn<(txHash: string) => Promise<TxDetails>>();
const mockBlocks = jest.fn<(blockHash: string) => Promise<BlockDetails>>();
const mockGetBlockfrostInstance = jest.fn(() => ({ txs: mockTxs, blocks: mockBlocks }));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: mockGetBlockfrostInstance,
}));

const { lookupConfirmedChainTx } = await import('./chain-tx-lookup');

const TX_HASH = 'ab'.repeat(32);
const OTHER_TX_HASH = 'cd'.repeat(32);
const BLOCK_HASH = 'block-1';

function lookup(overrides: Partial<Parameters<typeof lookupConfirmedChainTx>[0]> = {}) {
	return lookupConfirmedChainTx({
		network: Network.Preprod,
		rpcProviderApiKey: 'project-key',
		txHash: TX_HASH,
		requiredConfirmations: 5,
		...overrides,
	});
}

describe('lookupConfirmedChainTx', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockTxs.mockResolvedValue({
			hash: TX_HASH,
			block: BLOCK_HASH,
			valid_contract: true,
		});
		mockBlocks.mockResolvedValue({ confirmations: 5 });
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('accepts only evidence for the exact requested transaction hash', async () => {
		await expect(lookup()).resolves.toBe('confirmed-valid');
		expect(mockTxs).toHaveBeenCalledWith(TX_HASH);

		mockTxs.mockResolvedValueOnce({
			hash: OTHER_TX_HASH,
			block: BLOCK_HASH,
			valid_contract: true,
		});
		await expect(lookup()).resolves.toBe('transient-error');
		expect(mockBlocks).toHaveBeenCalledTimes(1);
	});

	it('distinguishes phase-2 valid and invalid confirmed transactions', async () => {
		await expect(lookup()).resolves.toBe('confirmed-valid');

		mockTxs.mockResolvedValueOnce({
			hash: TX_HASH,
			block: BLOCK_HASH,
			valid_contract: false,
		});
		await expect(lookup()).resolves.toBe('confirmed-invalid');
	});

	it('requires the configured confirmation threshold', async () => {
		mockBlocks.mockResolvedValueOnce({ confirmations: 4 });
		await expect(lookup()).resolves.toBe('pending');

		mockBlocks.mockResolvedValueOnce({ confirmations: 5 });
		await expect(lookup()).resolves.toBe('confirmed-valid');

		await expect(lookup({ requiredConfirmations: 0 })).resolves.toBe('confirmed-valid');
		expect(mockBlocks).toHaveBeenCalledTimes(2);
	});

	it('classifies only a structured transaction 404 as not found', async () => {
		mockTxs.mockRejectedValueOnce({ status_code: 404 });
		await expect(lookup()).resolves.toBe('not-found');

		mockTxs.mockRejectedValueOnce({ status_code: 503 });
		await expect(lookup()).resolves.toBe('transient-error');

		mockTxs.mockRejectedValueOnce(new Error('The requested component has not been found'));
		await expect(lookup()).resolves.toBe('transient-error');
	});

	it.each([
		['404', { status_code: 404 }],
		['transient failure', { status_code: 503 }],
	] as const)('treats a block lookup %s as transient after the transaction was found', async (_label, error) => {
		mockBlocks.mockRejectedValueOnce(error);
		await expect(lookup()).resolves.toBe('transient-error');
	});

	it.each([
		['mismatched hash', { hash: OTHER_TX_HASH, block: BLOCK_HASH, valid_contract: true }],
		['missing block hash', { hash: TX_HASH, block: '', valid_contract: true }],
		['missing phase-2 result', { hash: TX_HASH, block: BLOCK_HASH }],
	] as const)('rejects malformed transaction evidence: %s', async (_label, details) => {
		mockTxs.mockResolvedValueOnce(details as TxDetails);
		await expect(lookup()).resolves.toBe('transient-error');
	});

	it.each([
		['missing', {}],
		['negative', { confirmations: -1 }],
		['fractional', { confirmations: 5.5 }],
		['non-numeric', { confirmations: '5' }],
	] as const)('rejects malformed block evidence: %s confirmations', async (_label, block) => {
		mockBlocks.mockResolvedValueOnce(block as BlockDetails);
		await expect(lookup()).resolves.toBe('transient-error');
	});

	it.each([
		['non-canonical hash', { txHash: TX_HASH.toUpperCase() }],
		['negative confirmations', { requiredConfirmations: -1 }],
		['invalid timeout', { observerTimeoutMs: 0 }],
	] as const)('fails closed before querying for invalid parameters: %s', async (_label, overrides) => {
		await expect(lookup(overrides)).resolves.toBe('transient-error');
		expect(mockGetBlockfrostInstance).not.toHaveBeenCalled();
	});

	it('bounds a hung transaction lookup', async () => {
		jest.useFakeTimers();
		mockTxs.mockImplementationOnce(async () => await new Promise(() => undefined));

		const result = lookup({ observerTimeoutMs: 10 });
		await jest.advanceTimersByTimeAsync(10);

		await expect(result).resolves.toBe('transient-error');
	});

	it('bounds a hung block lookup', async () => {
		jest.useFakeTimers();
		mockBlocks.mockImplementationOnce(async () => await new Promise(() => undefined));

		const result = lookup({ observerTimeoutMs: 10 });
		await Promise.resolve();
		await jest.advanceTimersByTimeAsync(10);

		await expect(result).resolves.toBe('transient-error');
	});
});
