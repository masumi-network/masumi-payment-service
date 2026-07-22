import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockGetTxs = jest.fn() as AnyMock;
const mockGetExtended = jest.fn() as AnyMock;
const mockQuarantine = jest.fn() as AnyMock;
const mockExtract = jest.fn() as AnyMock;
const mockFindPending = jest.fn() as AnyMock;
const mockFindCanonicalPending = jest.fn() as AnyMock;
const mockFindPaymentSources = jest.fn() as AnyMock;
const mockUpdatePaymentSource = jest.fn() as AnyMock;
const mockFencePaymentSource = jest.fn() as AnyMock;
const mockUpsertIdentifier = jest.fn() as AnyMock;
const mockTransaction = jest.fn() as AnyMock;
const mockCreateApiClient = jest.fn(() => ({}));
const mockUpdateInitialTransactions = jest.fn() as AnyMock;
const mockUpdateTransaction = jest.fn() as AnyMock;
const mockUpdateRolledBackTransaction = jest.fn() as AnyMock;
const mockMarkCanonicalRollbacks = jest.fn() as AnyMock;
const mockSettleCanonicalRollbacks = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockTransaction,
		txSyncQuarantine: { findFirst: mockFindPending, findMany: mockFindCanonicalPending },
		paymentSource: {
			findMany: mockFindPaymentSources,
			update: mockUpdatePaymentSource,
			updateMany: mockFencePaymentSource,
		},
		paymentSourceIdentifiers: { upsert: mockUpsertIdentifier },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 3, SYNC_LOCK_TIMEOUT_INTERVAL: 180_000 },
	CONSTANTS: { DEFAULT_MAX_PARALLEL_TRANSACTIONS_EXTENDED_LOOKUP: 2 },
}));

jest.unstable_mockModule('@/services/shared', () => ({
	createApiClient: mockCreateApiClient,
	withJobLock: jest.fn(),
}));

jest.unstable_mockModule('./blockchain', () => ({
	getTxsFromCardanoAfterSpecificTx: mockGetTxs,
	getExtendedTxInformation: mockGetExtended,
}));

jest.unstable_mockModule('./quarantine', () => ({
	QUARANTINE_CHAIN_ORDER: [],
	quarantineTransaction: mockQuarantine,
	markCanonicalRolledBackQuarantines: mockMarkCanonicalRollbacks,
	settleCanonicalRolledBackQuarantines: mockSettleCanonicalRollbacks,
}));

jest.unstable_mockModule('./util', () => ({
	extractOnChainTransactionData: mockExtract,
}));

jest.unstable_mockModule('./tx', () => ({
	updateInitialTransactions: mockUpdateInitialTransactions,
	updateRolledBackTransaction: mockUpdateRolledBackTransaction,
	updateTransaction: mockUpdateTransaction,
}));

const { processPaymentSource, processTransactionData, queryAndLockPaymentSourcesForSync, unlockPaymentSources } =
	await import('./service');

const paymentSource = {
	id: 'source-1',
	network: 'Preprod',
	smartContractAddress: 'addr_test1_contract',
	lastIdentifierChecked: 'previous',
	syncInProgress: true,
	txSyncFenceVersion: 1,
	PaymentSourceConfig: { rpcProviderApiKey: 'key' },
} as Parameters<typeof processPaymentSource>[0];

function enumeratedTx(txHash: string, blockHeight: number, txIndex: number) {
	return { tx_hash: txHash, block_time: blockHeight, block_height: blockHeight, tx_index: txIndex };
}

function extendedTx(txHash: string, blockHeight: number, txIndex: number, confirmations = 10) {
	return {
		tx: { tx_hash: txHash },
		block: { confirmations },
		blockTime: blockHeight,
		blockHeight,
		txIndex,
		metadata: {},
		utxos: {},
		transaction: {},
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	paymentSource.txSyncFenceVersion = 1;
	mockFindPending.mockResolvedValue(null);
	mockFindCanonicalPending.mockResolvedValue([]);
	mockFindPaymentSources.mockResolvedValue([]);
	mockUpdatePaymentSource.mockResolvedValue({});
	mockFencePaymentSource.mockResolvedValue({ count: 1 });
	mockUpsertIdentifier.mockResolvedValue({});
	mockTransaction.mockImplementation(async (operation: AnyMock) =>
		operation({
			paymentSource: {
				findMany: mockFindPaymentSources,
				update: mockUpdatePaymentSource,
				updateMany: mockFencePaymentSource,
			},
			paymentSourceIdentifiers: { upsert: mockUpsertIdentifier },
		}),
	);
	mockQuarantine.mockImplementation(
		async ({ expectedFenceVersion }: { expectedFenceVersion: number }) => Number(expectedFenceVersion) + 1,
	);
	mockMarkCanonicalRollbacks.mockImplementation(
		async ({ paymentSourceId, txHashes, expectedFenceVersion }: Record<string, unknown>) => ({
			paymentSourceId,
			txHashes,
			txSyncFenceVersion: Number(expectedFenceVersion) + 1,
		}),
	);
	mockSettleCanonicalRollbacks.mockResolvedValue(undefined);
	mockUpdateRolledBackTransaction.mockResolvedValue(undefined);
	mockExtract.mockReturnValue({ type: 'Invalid', error: 'foreign tx' });
});

describe('payment-source sync ownership', () => {
	it('increments and returns a versioned scanner ownership token', async () => {
		mockFindPaymentSources.mockResolvedValueOnce([
			{ ...paymentSource, syncInProgress: false, txSyncFenceVersion: 4, updatedAt: new Date(0) },
		]);
		mockFencePaymentSource.mockResolvedValueOnce({ count: 1 });

		const acquired = await queryAndLockPaymentSourcesForSync();

		expect(acquired).toEqual([
			expect.objectContaining({ id: 'source-1', syncInProgress: true, txSyncFenceVersion: 5 }),
		]);
		expect(mockFencePaymentSource).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: 'source-1', txSyncFenceVersion: 4 }),
				data: { syncInProgress: true, txSyncFenceVersion: { increment: 1 } },
			}),
		);
	});

	it('does not let a stale scanner unlock a newer owner', async () => {
		mockFencePaymentSource.mockResolvedValueOnce({ count: 0 });

		await unlockPaymentSources([{ ...paymentSource, txSyncFenceVersion: 4 }]);

		expect(mockFencePaymentSource).toHaveBeenCalledWith({
			where: { id: 'source-1', syncInProgress: true, txSyncFenceVersion: 4 },
			data: { syncInProgress: false },
		});
	});
});

describe('processPaymentSource chain ordering', () => {
	it('settles canonically rolled-back quarantine rows before returning on an empty replacement page', async () => {
		mockGetTxs.mockResolvedValue({
			latestTx: [],
			rolledBackTx: [{ tx_hash: 'rolled-back-a' }],
			rollbackAnchor: null,
		});

		await processPaymentSource(paymentSource, 2);

		expect(mockMarkCanonicalRollbacks).toHaveBeenCalledWith({
			paymentSourceId: 'source-1',
			txHashes: ['rolled-back-a'],
			expectedFenceVersion: 1,
		});
		expect(mockUpdateRolledBackTransaction).toHaveBeenCalledWith([{ tx_hash: 'rolled-back-a' }], expect.any(Function));
		expect(mockMarkCanonicalRollbacks.mock.invocationCallOrder[0]).toBeLessThan(
			mockUpdateRolledBackTransaction.mock.invocationCallOrder[0],
		);
		expect(mockUpdateRolledBackTransaction.mock.invocationCallOrder[0]).toBeLessThan(
			mockSettleCanonicalRollbacks.mock.invocationCallOrder[0],
		);
		expect(mockSettleCanonicalRollbacks).toHaveBeenCalledWith(
			{
				paymentSourceId: 'source-1',
				txHashes: ['rolled-back-a'],
				txSyncFenceVersion: 2,
			},
			null,
		);
	});

	it('does not rewind the cursor when the rollback business mutation fails', async () => {
		mockGetTxs.mockResolvedValue({
			latestTx: [],
			rolledBackTx: [{ tx_hash: 'rolled-back-a' }],
			rollbackAnchor: null,
		});
		mockUpdateRolledBackTransaction.mockRejectedValueOnce(new Error('rollback write failed'));

		await expect(processPaymentSource(paymentSource, 2)).rejects.toThrow('rollback write failed');

		expect(mockSettleCanonicalRollbacks).not.toHaveBeenCalled();
	});

	it('recovers an unresolved rollback marker before reading a same-hash reinclusion', async () => {
		const sameHash = 'same-hash-tip';
		mockFindCanonicalPending.mockResolvedValueOnce([{ txHash: sameHash }]);
		mockGetTxs.mockResolvedValue({
			latestTx: [enumeratedTx(sameHash, 101, 0)],
			rolledBackTx: [],
			rollbackAnchor: null,
		});
		mockGetExtended.mockResolvedValue({
			txData: [extendedTx(sameHash, 101, 0)],
			failures: [],
		});

		await processPaymentSource(paymentSource, 2);

		expect(mockUpdateRolledBackTransaction).toHaveBeenCalledWith([{ tx_hash: sameHash }], expect.any(Function));
		expect(mockSettleCanonicalRollbacks).toHaveBeenCalledWith(
			{
				paymentSourceId: 'source-1',
				txHashes: [sameHash],
				txSyncFenceVersion: 1,
			},
			null,
		);
		expect(mockGetTxs).toHaveBeenCalledWith({}, expect.anything(), null);
		expect(mockExtract).toHaveBeenCalledWith(expect.objectContaining({ tx: { tx_hash: sameHash } }), expect.anything());
	});

	it('enumerates a rolled-back tip again when the same hash is canonically re-included', async () => {
		const sameHash = 'same-hash-tip';
		mockGetTxs
			.mockResolvedValueOnce({
				latestTx: [],
				rolledBackTx: [{ tx_hash: sameHash }],
				rollbackAnchor: null,
			})
			.mockResolvedValueOnce({
				latestTx: [enumeratedTx(sameHash, 101, 0)],
				rolledBackTx: [],
				rollbackAnchor: null,
			});
		mockGetExtended.mockResolvedValueOnce({
			txData: [extendedTx(sameHash, 101, 0)],
			failures: [],
		});

		await processPaymentSource(paymentSource, 2);
		await processPaymentSource({ ...paymentSource, lastIdentifierChecked: null }, 2);

		expect(mockGetTxs).toHaveBeenNthCalledWith(2, {}, expect.anything(), null);
		expect(mockExtract).toHaveBeenCalledWith(expect.objectContaining({ tx: { tx_hash: sameHash } }), expect.anything());
		expect(mockUpdatePaymentSource.mock.calls.map(([input]) => input.data?.lastIdentifierChecked)).toEqual([sameHash]);
	});

	it('queues the full suffix after a processing failure instead of applying a descendant', async () => {
		mockGetTxs.mockResolvedValue({
			latestTx: [enumeratedTx('tx-a', 100, 1), enumeratedTx('tx-b', 100, 2)],
			rolledBackTx: [],
		});
		mockGetExtended.mockResolvedValue({
			txData: [extendedTx('tx-a', 100, 1), extendedTx('tx-b', 100, 2)],
			failures: [],
		});
		mockExtract.mockImplementation((tx: { tx: { tx_hash: string } }) => {
			if (tx.tx.tx_hash === 'tx-a') throw new Error('datum failure');
			return { type: 'Invalid', error: 'must not run' };
		});

		await processPaymentSource(paymentSource, 2);

		expect(mockExtract).toHaveBeenCalledTimes(1);
		expect(mockQuarantine).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ txHash: 'tx-a', reason: 'ProcessingFailed' }),
		);
		expect(mockQuarantine).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ txHash: 'tx-b', reason: 'PredecessorPending' }),
		);
		expect(mockUpdatePaymentSource).toHaveBeenCalledTimes(2);
	});

	it('defers new descendants when an older quarantine row is not currently due', async () => {
		mockFindPending.mockResolvedValue({ txHash: 'tx-a' });
		mockGetTxs.mockResolvedValue({ latestTx: [enumeratedTx('tx-b', 101, 0)], rolledBackTx: [] });
		mockGetExtended.mockResolvedValue({ txData: [extendedTx('tx-b', 101, 0)], failures: [] });

		await processPaymentSource(paymentSource, 2);

		expect(mockExtract).not.toHaveBeenCalled();
		expect(mockQuarantine).toHaveBeenCalledWith(
			expect.objectContaining({ txHash: 'tx-b', reason: 'PredecessorPending' }),
		);
		expect(mockUpdatePaymentSource).toHaveBeenCalledTimes(1);
	});

	it('keeps the checkpoint before a shallow predecessor and does not queue a later failure', async () => {
		mockGetTxs.mockResolvedValue({
			latestTx: [enumeratedTx('shallow', 102, 0), enumeratedTx('lookup-failed', 103, 0)],
			rolledBackTx: [],
		});
		mockGetExtended.mockResolvedValue({
			txData: [extendedTx('shallow', 102, 0, 1)],
			failures: [
				{
					txHash: 'lookup-failed',
					blockHeight: 103,
					txIndex: 0,
					error: new Error('provider timeout'),
				},
			],
		});

		await processPaymentSource(paymentSource, 2);

		expect(mockQuarantine).not.toHaveBeenCalled();
		expect(mockUpdatePaymentSource).not.toHaveBeenCalled();
		expect(mockExtract).not.toHaveBeenCalled();
	});
});

describe('processTransactionData lease fencing', () => {
	it('passes the before-write fence to every transaction entry', async () => {
		const entries = [{ id: 'entry-1' }, { id: 'entry-2' }];
		const beforeWrite = jest.fn(async () => undefined);
		mockExtract.mockReturnValueOnce({ type: 'Transaction', entries });
		mockUpdateTransaction.mockResolvedValue(undefined);
		const tx = extendedTx('tx-a', 100, 1);

		await processTransactionData(tx as never, paymentSource, {} as never, { beforeWrite });

		expect(mockUpdateTransaction).toHaveBeenCalledTimes(2);
		expect(mockUpdateTransaction).toHaveBeenNthCalledWith(1, paymentSource, entries[0], {}, tx, beforeWrite);
		expect(mockUpdateTransaction).toHaveBeenNthCalledWith(2, paymentSource, entries[1], {}, tx, beforeWrite);
	});
});
