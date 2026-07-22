import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockQuarantineUpdateMany = jest.fn() as AnyMock;
const mockPaymentSourceUpdateMany = jest.fn() as AnyMock;
const mockPaymentSourceUpdate = jest.fn() as AnyMock;
const mockPaymentSourceFindUniqueOrThrow = jest.fn() as AnyMock;
const mockCount = jest.fn() as AnyMock;
const mockFindFirst = jest.fn() as AnyMock;
const mockFindUnique = jest.fn() as AnyMock;
const mockUpdate = jest.fn() as AnyMock;
const mockCreate = jest.fn() as AnyMock;
const mockUpsert = jest.fn() as AnyMock;
const mockTransaction = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockTransaction,
		txSyncQuarantine: {
			updateMany: mockQuarantineUpdateMany,
			count: mockCount,
			findFirst: mockFindFirst,
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

const {
	nextRetryDelayMs,
	errorToText,
	claimQuarantinedTransaction,
	fenceQuarantineClaimWrite,
	getQuarantineHealth,
	markCanonicalRolledBackQuarantines,
	quarantineTransaction,
	releaseQuarantineClaim,
	resolveQuarantinedTransaction,
	settleCanonicalRolledBackQuarantines,
	MAX_QUARANTINE_ATTEMPTS,
	QUARANTINE_CHAIN_ORDER,
	compareQuarantineChainPosition,
} = await import('./index');

const txdb = {
	paymentSource: {
		updateMany: mockPaymentSourceUpdateMany,
		update: mockPaymentSourceUpdate,
		findUniqueOrThrow: mockPaymentSourceFindUniqueOrThrow,
	},
	txSyncQuarantine: {
		findFirst: mockFindFirst,
		findUnique: mockFindUnique,
		updateMany: mockQuarantineUpdateMany,
		update: mockUpdate,
		create: mockCreate,
		upsert: mockUpsert,
	},
};

beforeEach(() => {
	jest.clearAllMocks();
	mockTransaction.mockImplementation(async (operation: AnyMock) => operation(txdb));
});

describe('quarantine helpers', () => {
	it('uses bounded retry delays', () => {
		expect(nextRetryDelayMs(0)).toBe(30_000);
		expect(nextRetryDelayMs(2)).toBeGreaterThan(nextRetryDelayMs(1));
		expect(nextRetryDelayMs(50)).toBe(nextRetryDelayMs(MAX_QUARANTINE_ATTEMPTS));
		expect(nextRetryDelayMs(-1)).toBe(30_000);
	});

	it('serialises arbitrary errors without throwing', () => {
		expect(errorToText(new TypeError('bad datum'))).toBe('TypeError: bad datum');
		expect(errorToText({ status: 429 })).toBe('{"status":429}');
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => errorToText(circular)).not.toThrow();
	});

	it('orders unknown legacy positions before known descendants', () => {
		expect(QUARANTINE_CHAIN_ORDER.slice(0, 2)).toEqual([
			{ blockHeight: { sort: 'asc', nulls: 'first' } },
			{ txIndex: { sort: 'asc', nulls: 'first' } },
		]);
		expect(
			compareQuarantineChainPosition(
				{ id: 'unknown', blockHeight: null, txIndex: null, createdAt: new Date(0) },
				{ id: 'known', blockHeight: 10, txIndex: 0, createdAt: new Date(0) },
			),
		).toBeLessThan(0);
	});
});

describe('quarantine processing ownership', () => {
	it('atomically acquires the source and captures its incremented fence version', async () => {
		mockPaymentSourceUpdateMany.mockResolvedValueOnce({ count: 1 });
		mockPaymentSourceFindUniqueOrThrow.mockResolvedValueOnce({ txSyncFenceVersion: 8 });
		mockFindFirst.mockResolvedValueOnce({ id: 'entry-1' });
		mockQuarantineUpdateMany.mockResolvedValueOnce({ count: 1 });
		const nowMs = Date.now();
		const updatedAt = new Date(nowMs - 1000);

		await expect(
			claimQuarantinedTransaction({ id: 'entry-1', paymentSourceId: 'source-1', updatedAt }, nowMs),
		).resolves.toEqual({
			id: 'entry-1',
			paymentSourceId: 'source-1',
			processingLeaseId: expect.any(String),
			txSyncFenceVersion: 8,
		});

		expect(mockPaymentSourceUpdateMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({ id: 'source-1', disableSyncAt: null }),
				data: { syncInProgress: true, txSyncFenceVersion: { increment: 1 } },
			}),
		);
		expect(mockQuarantineUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'entry-1',
					canonicalRollbackAt: null,
				}),
			}),
		);
	});

	it('releases source ownership when the atomic predecessor check changes', async () => {
		mockPaymentSourceUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
		mockPaymentSourceFindUniqueOrThrow.mockResolvedValueOnce({ txSyncFenceVersion: 8 });
		mockFindFirst.mockResolvedValueOnce({ id: 'earlier' });

		await expect(
			claimQuarantinedTransaction({
				id: 'later',
				paymentSourceId: 'source-1',
				updatedAt: new Date(),
			}),
		).resolves.toBeNull();

		expect(mockPaymentSourceUpdateMany).toHaveBeenLastCalledWith({
			where: { id: 'source-1', txSyncFenceVersion: 8, syncInProgress: true },
			data: { syncInProgress: false },
		});
		expect(mockQuarantineUpdateMany).not.toHaveBeenCalled();
	});

	it('fences source version and active row lease through the supplied business transaction', async () => {
		mockPaymentSourceUpdateMany.mockResolvedValueOnce({ count: 1 });
		mockQuarantineUpdateMany.mockResolvedValueOnce({ count: 1 });
		const nowMs = Date.now();
		const claim = {
			id: 'entry-1',
			paymentSourceId: 'source-1',
			processingLeaseId: 'lease-1',
			txSyncFenceVersion: 8,
		};

		await fenceQuarantineClaimWrite(txdb as never, claim, nowMs);

		expect(mockPaymentSourceUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'source-1',
				deletedAt: null,
				syncInProgress: true,
				txSyncFenceVersion: 8,
			},
			data: { syncInProgress: true },
		});
		expect(mockQuarantineUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'entry-1',
					processingLeaseId: 'lease-1',
					processingLeaseExpiresAt: { gt: new Date(nowMs) },
					canonicalRollbackAt: null,
				}),
			}),
		);
	});

	it('does not resolve after the source version or active lease is lost', async () => {
		mockPaymentSourceUpdateMany.mockResolvedValueOnce({ count: 1 });
		mockQuarantineUpdateMany.mockResolvedValueOnce({ count: 0 });
		const claim = {
			id: 'entry-1',
			paymentSourceId: 'source-1',
			processingLeaseId: 'old-lease',
			txSyncFenceVersion: 8,
		};

		await expect(resolveQuarantinedTransaction(claim)).rejects.toThrow('Quarantine processing lease lost');
		expect(mockPaymentSourceUpdateMany).toHaveBeenCalledTimes(1);
	});

	it('clears its old row token even when a newer source owner replaced its version', async () => {
		mockPaymentSourceUpdateMany.mockResolvedValueOnce({ count: 0 });
		mockQuarantineUpdateMany.mockResolvedValueOnce({ count: 1 });
		const claim = {
			id: 'entry-1',
			paymentSourceId: 'source-1',
			processingLeaseId: 'old-lease',
			txSyncFenceVersion: 8,
		};

		await expect(releaseQuarantineClaim(claim)).resolves.toBeUndefined();
		expect(mockQuarantineUpdateMany).toHaveBeenCalledWith({
			where: { id: 'entry-1', processingLeaseId: 'old-lease', resolvedAt: null },
			data: { processingLeaseId: null, processingLeaseExpiresAt: null },
		});
	});
});

describe('canonical rollback barrier', () => {
	it('bumps the source epoch and upserts unresolved marker rows without settling them', async () => {
		mockPaymentSourceUpdateMany.mockResolvedValueOnce({ count: 1 });
		mockUpsert.mockResolvedValue({});
		const nowMs = Date.now();

		await expect(
			markCanonicalRolledBackQuarantines({
				paymentSourceId: 'source-1',
				txHashes: ['tx-a', 'tx-b'],
				expectedFenceVersion: 4,
				nowMs,
			}),
		).resolves.toEqual({
			paymentSourceId: 'source-1',
			txHashes: ['tx-a', 'tx-b'],
			txSyncFenceVersion: 5,
		});

		expect(mockUpsert).toHaveBeenCalledTimes(2);
		expect(mockUpsert).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				create: expect.objectContaining({
					txHash: 'tx-a',
					blockHeight: null,
					txIndex: null,
					reason: 'CanonicalRollback',
					canonicalRollbackAt: new Date(nowMs),
				}),
				update: expect.objectContaining({ resolvedAt: null, reason: 'CanonicalRollback' }),
			}),
		);
		expect(mockQuarantineUpdateMany).not.toHaveBeenCalled();
	});

	it('settles markers and rewinds the cursor atomically after rollback writes succeed', async () => {
		mockPaymentSourceUpdateMany.mockResolvedValueOnce({ count: 1 });
		mockQuarantineUpdateMany.mockResolvedValueOnce({ count: 2 });
		const resolvedAt = new Date(2000);

		await settleCanonicalRolledBackQuarantines(
			{
				paymentSourceId: 'source-1',
				txHashes: ['tx-a', 'tx-b'],
				txSyncFenceVersion: 5,
			},
			'canonical-anchor',
			resolvedAt.getTime(),
		);

		expect(mockQuarantineUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ canonicalRollbackAt: { not: null }, resolvedAt: null }),
				data: expect.objectContaining({ resolvedAt, processingLeaseId: null }),
			}),
		);
		expect(mockPaymentSourceUpdate).toHaveBeenCalledWith({
			where: { id: 'source-1', deletedAt: null },
			data: { lastIdentifierChecked: 'canonical-anchor' },
		});
	});
});

describe('quarantineTransaction', () => {
	it('bumps the owned source epoch and refreshes a live leased row without clearing its token', async () => {
		mockPaymentSourceUpdateMany.mockResolvedValueOnce({ count: 1 });
		mockFindUnique.mockResolvedValueOnce({
			id: 'entry-1',
			processingLeaseId: 'live-lease',
			processingLeaseExpiresAt: new Date(Date.now() + 60_000),
		});
		mockUpdate.mockResolvedValueOnce({});

		await expect(
			quarantineTransaction({
				paymentSourceId: 'source-1',
				txHash: 'tx-1',
				blockHeight: 100,
				txIndex: 1,
				reason: 'ProcessingFailed' as never,
				error: new Error('new classification'),
				expectedFenceVersion: 8,
			}),
		).resolves.toBe(9);

		const data = mockUpdate.mock.calls[0][0].data;
		expect(data).toEqual(
			expect.objectContaining({
				blockHeight: 100,
				txIndex: 1,
				canonicalRollbackAt: null,
			}),
		);
		expect(data).not.toHaveProperty('processingLeaseId');
		expect(data).not.toHaveProperty('processingLeaseExpiresAt');
	});
});

describe('getQuarantineHealth', () => {
	it('excludes rows owned by soft-deleted payment sources', async () => {
		mockCount.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
		mockFindFirst.mockResolvedValueOnce(null);

		await getQuarantineHealth();

		for (const call of mockCount.mock.calls) {
			expect(call[0]).toEqual(
				expect.objectContaining({
					where: expect.objectContaining({ PaymentSource: { deletedAt: null } }),
				}),
			);
		}
	});
});
