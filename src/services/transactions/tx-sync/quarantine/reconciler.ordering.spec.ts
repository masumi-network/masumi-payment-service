import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockClaim = jest.fn() as AnyMock;
const mockRecordAttempt = jest.fn() as AnyMock;
const mockGetExtended = jest.fn() as AnyMock;
const mockProcess = jest.fn() as AnyMock;
const mockMarkNeedsOperator = jest.fn() as AnyMock;
const mockRelease = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { txSyncQuarantine: { findMany: mockFindMany } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 3 },
}));

jest.unstable_mockModule('@/services/shared', () => ({
	createApiClient: jest.fn(() => ({})),
	withJobLock: jest.fn(async (_mutex: unknown, _name: string, operation: () => Promise<void>) => await operation()),
}));

jest.unstable_mockModule('../blockchain', () => ({
	getExtendedTxInformation: mockGetExtended,
}));

jest.unstable_mockModule('../service', () => ({
	processTransactionData: mockProcess,
}));

jest.unstable_mockModule('./index', () => ({
	QUARANTINE_CHAIN_ORDER: [],
	claimQuarantinedTransaction: mockClaim,
	compareQuarantineChainPosition: (left: { blockHeight: number }, right: { blockHeight: number }) =>
		left.blockHeight - right.blockHeight,
	deferClaimedQuarantine: jest.fn(),
	errorToText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
	fenceQuarantineClaimWrite: jest.fn(),
	getQuarantineHealth: jest.fn(async () => ({ pending: 0, needsOperator: 0, oldestPendingAgeMs: null })),
	isQuarantineLeaseLostError: (error: unknown) => error instanceof Error && error.name === 'QuarantineLeaseLostError',
	markClaimedQuarantineNeedsOperator: mockMarkNeedsOperator,
	recordQuarantineAttempt: mockRecordAttempt,
	releaseQuarantineClaim: mockRelease,
	resolveQuarantinedTransaction: jest.fn(),
}));

const { reconcileQuarantinedTransactions } = await import('./reconciler');

function quarantineEntry(id: string, txHash: string, paymentSourceId = 'source-1') {
	return {
		id,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		paymentSourceId,
		txHash,
		blockHeight: 100,
		txIndex: id === 'entry-a' ? 1 : 2,
		attempts: 0,
		needsOperator: false,
		nextRetryAt: new Date(0),
		canonicalRollbackAt: null as Date | null,
		PaymentSource: {
			id: paymentSourceId,
			network: 'Preprod',
			PaymentSourceConfig: { rpcProviderApiKey: 'key' },
		},
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockRecordAttempt.mockResolvedValue(undefined);
	mockProcess.mockResolvedValue(undefined);
	mockRelease.mockResolvedValue(undefined);
});

describe('reconcileQuarantinedTransactions ordering', () => {
	it('does not claim or apply B after A remains unresolved in the same tick', async () => {
		const entryA = quarantineEntry('entry-a', 'tx-a');
		const entryB = quarantineEntry('entry-b', 'tx-b');
		mockFindMany.mockResolvedValue([entryA, entryB]);
		mockClaim.mockResolvedValueOnce({
			id: entryA.id,
			paymentSourceId: entryA.paymentSourceId,
			processingLeaseId: 'lease-a',
			txSyncFenceVersion: 2,
		});
		mockGetExtended.mockResolvedValueOnce({
			txData: [],
			failures: [{ error: new Error('provider timeout') }],
		});

		await reconcileQuarantinedTransactions();

		expect(mockClaim).toHaveBeenCalledTimes(1);
		expect(mockClaim).toHaveBeenCalledWith(entryA);
		expect(mockRecordAttempt).toHaveBeenCalledTimes(1);
		expect(mockProcess).not.toHaveBeenCalled();
	});

	it('does not apply a due B when the atomic claim sees an earlier unresolved predecessor', async () => {
		const entryB = quarantineEntry('entry-b', 'tx-b');
		mockFindMany.mockResolvedValue([entryB]);
		mockClaim.mockResolvedValueOnce(null);

		await reconcileQuarantinedTransactions();

		expect(mockClaim).toHaveBeenCalledWith(entryB);
		expect(mockGetExtended).not.toHaveBeenCalled();
		expect(mockProcess).not.toHaveBeenCalled();
	});

	it('does not let blocked descendants from one source starve another source head', async () => {
		const blockedHead = quarantineEntry('entry-a', 'tx-a', 'source-blocked');
		blockedHead.needsOperator = true;
		const eligibleHead = quarantineEntry('entry-b', 'tx-b', 'source-eligible');
		mockFindMany.mockResolvedValue([blockedHead, eligibleHead]);
		mockClaim.mockResolvedValueOnce({
			id: eligibleHead.id,
			paymentSourceId: eligibleHead.paymentSourceId,
			processingLeaseId: 'lease-b',
			txSyncFenceVersion: 2,
		});
		mockGetExtended.mockResolvedValueOnce({
			txData: [],
			failures: [{ error: new Error('provider timeout') }],
		});

		await reconcileQuarantinedTransactions();

		expect(mockClaim).toHaveBeenCalledTimes(1);
		expect(mockClaim).toHaveBeenCalledWith(eligibleHead);
		expect(mockFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				distinct: ['paymentSourceId'],
				where: {
					resolvedAt: null,
					PaymentSource: { deletedAt: null },
				},
			}),
		);
	});

	it('keeps repeated same-provider 404s retryable instead of inferring rollback', async () => {
		const entry = quarantineEntry('entry-a', 'tx-a');
		entry.attempts = 11;
		mockFindMany.mockResolvedValue([entry]);
		mockClaim.mockResolvedValueOnce({
			id: entry.id,
			paymentSourceId: entry.paymentSourceId,
			processingLeaseId: 'lease-a',
			txSyncFenceVersion: 2,
		});
		mockGetExtended.mockResolvedValueOnce({
			txData: [],
			failures: [{ error: { status_code: 404, message: 'The requested component has not been found.' } }],
		});

		await reconcileQuarantinedTransactions();

		expect(mockRecordAttempt).toHaveBeenCalledWith(
			expect.objectContaining({
				attempts: 11,
				error: expect.objectContaining({ status_code: 404 }),
			}),
		);
	});

	it('leaves a canonically marked head unresolved for scanner settlement', async () => {
		const entry = quarantineEntry('entry-a', 'tx-a');
		entry.canonicalRollbackAt = new Date();
		entry.needsOperator = true;
		entry.nextRetryAt = new Date(Date.now() + 60_000);
		mockFindMany.mockResolvedValue([entry]);

		await reconcileQuarantinedTransactions();

		expect(mockClaim).not.toHaveBeenCalled();
		expect(mockGetExtended).not.toHaveBeenCalled();
	});

	it('releases a lost lease without classifying it as a retry or terminal failure', async () => {
		const entry = quarantineEntry('entry-a', 'tx-a');
		const claim = {
			id: entry.id,
			paymentSourceId: entry.paymentSourceId,
			processingLeaseId: 'lease-a',
			txSyncFenceVersion: 2,
		};
		const leaseLost = new Error('lease lost');
		leaseLost.name = 'QuarantineLeaseLostError';
		mockFindMany.mockResolvedValue([entry]);
		mockClaim.mockResolvedValueOnce(claim);
		mockGetExtended.mockResolvedValueOnce({ txData: [{ block: { confirmations: 10 } }], failures: [] });
		mockProcess.mockRejectedValueOnce(leaseLost);

		await reconcileQuarantinedTransactions();

		expect(mockRelease).toHaveBeenCalledWith(claim);
		expect(mockRecordAttempt).not.toHaveBeenCalled();
		expect(mockMarkNeedsOperator).not.toHaveBeenCalled();
	});
});
