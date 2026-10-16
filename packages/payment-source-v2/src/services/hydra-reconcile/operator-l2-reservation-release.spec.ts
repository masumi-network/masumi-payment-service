import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus, Network } from '@/generated/prisma/client';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockHeadFindUnique = jest.fn() as AnyMock;
const mockTransactionFindMany = jest.fn() as AnyMock;
const mockTransactionFindFirst = jest.fn() as AnyMock;
const mockGetNode = jest.fn() as AnyMock;
const mockRelease = jest.fn() as AnyMock;
const mockLoggerWarn = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: { findUnique: mockHeadFindUnique },
		transaction: { findMany: mockTransactionFindMany, findFirst: mockTransactionFindFirst },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: mockLoggerWarn, error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode }),
}));

jest.unstable_mockModule('./l2-reservation-release', () => ({
	releaseRejectedL2Reservation: mockRelease,
}));

const { listHeldL2Reservations, releaseHeldL2Reservation, L2_OPERATOR_RELEASE_GRACE_MS } =
	await import('./operator-l2-reservation-release');
const { L2_RESERVATION_RELEASE_GRACE_MS } = await import('./l2-reservation-recovery');
const { resolveHydraL2EvidenceSlotConfig } = await import('@/utils/hydra/l2-slot-context');

const NOW_MS = Date.UTC(2026, 9, 17);
const UPDATED_AT = new Date(NOW_MS - 60 * 60_000);
const inputA = `${'a'.repeat(64)}#0`;
const inputB = `${'b'.repeat(64)}#1`;
/** A preprod slot (past its zero slot) long before NOW_MS, so the body expired well past the grace. */
const EXPIRED_SLOT = 100_000n;
/** A slot far after NOW_MS. */
const LIVE_SLOT = 10_000_000_000n;

/** The preprod slot whose validity bound lies `msAgo` before NOW_MS. */
function slotExpiredAgo(msAgo: number): bigint {
	const config = resolveHydraL2EvidenceSlotConfig('preprod');
	if (!config) throw new Error('preprod slot config');
	return BigInt(Math.floor((NOW_MS - msAgo - config.zeroTime) / config.slotLength) + config.zeroSlot - 1);
}

function openHead(overrides: Record<string, unknown> = {}) {
	return {
		id: 'head-1',
		status: HydraHeadStatus.Open,
		isClosing: false,
		ownerEpoch: 1n,
		HydraRelation: { network: Network.Preprod },
		...overrides,
	};
}

function liveNode(overrides: Record<string, unknown> = {}) {
	return {
		hasVerifiedPinnedSessions: true,
		confirmedTransactionHistoryReady: true,
		getConfirmedTransactionsForReconciliation: () => [],
		headClock: { chainTimeMs: NOW_MS, receivedAtMs: NOW_MS },
		verifiedSnapshotNumber: 9n,
		getConfirmedTransaction: () => null,
		// The node maps inputA onto an output, inputB onto nothing.
		getVerifiedCurrentOutput: (reference: string) => (reference === inputA ? 'bytes' : null),
		...overrides,
	};
}

function reservationRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tx-1',
		updatedAt: UPDATED_AT,
		status: 'Pending',
		layer: 'L2',
		txHash: null,
		hydraHeadId: 'head-1',
		intendedTxHash: 'c'.repeat(64),
		invalidHereafterSlot: EXPIRED_SLOT,
		l2ReservationInputRefs: [inputA, inputB],
		l2ReleaseNudgeTx: null,
		l2RejectedByHeadReason: 'BadInputsUTxO',
		l2ReservationPreviousLayer: 'L1',
		l2ReservationPreviousSmartContractWalletId: null,
		l2ReservationPreviousBuyerReturnAddress: null,
		l2ReservationPreviousCollateralReturn: null,
		l2ReservationPreviousTransactionId: null,
		PurchaseRequestCurrent: [{ id: 'purchase-1', PaidFunds: [{ unit: '', amount: 10_000_000n }] }],
		PaymentRequestCurrent: [],
		BlocksWallet: { walletAddress: 'addr_test1wallet' },
		...overrides,
	};
}

const release = (overrides: Record<string, unknown> = {}) =>
	releaseHeldL2Reservation({
		headId: 'head-1',
		transactionId: 'tx-1',
		expectedUpdatedAt: UPDATED_AT,
		actorApiKeyId: 'admin-key',
		nowMs: NOW_MS,
		...overrides,
	});

beforeEach(() => {
	jest.clearAllMocks();
	mockHeadFindUnique.mockResolvedValue(openHead());
	mockTransactionFindMany.mockResolvedValue([reservationRow()]);
	mockTransactionFindFirst.mockResolvedValue(reservationRow());
	mockGetNode.mockReturnValue(liveNode());
	mockRelease.mockResolvedValue(true);
});

describe('listHeldL2Reservations', () => {
	it('shows an expired reservation as releasable, with the node hint and no evidence claim', async () => {
		const { reservations } = await listHeldL2Reservations('head-1', NOW_MS);

		expect(reservations).toEqual([
			expect.objectContaining({
				transactionId: 'tx-1',
				updatedAt: UPDATED_AT,
				kind: 'initial-lock',
				purchaseRequestIds: ['purchase-1'],
				walletAddress: 'addr_test1wallet',
				inputsReportedUnspent: 1,
				releaseNudgeTxHash: null,
				rejectedByHeadReason: 'BadInputsUTxO',
				releasable: true,
				blockedReason: null,
			}),
		]);
		expect(reservations[0].expiresAt).toBeInstanceOf(Date);
	});

	it('names an action reservation as one', async () => {
		mockTransactionFindMany.mockResolvedValue([reservationRow({ l2ReservationPreviousTransactionId: 'escrow-tx' })]);

		const { reservations } = await listHeldL2Reservations('head-1', NOW_MS);
		expect(reservations[0].kind).toBe('action');
	});

	it.each([
		[
			'the body has not expired',
			() => mockTransactionFindMany.mockResolvedValue([reservationRow({ invalidHereafterSlot: LIVE_SLOT })]),
		],
		[
			'the head clock is stale',
			() =>
				mockGetNode.mockReturnValue(
					liveNode({ headClock: { chainTimeMs: NOW_MS, receivedAtMs: NOW_MS - 10 * 60_000 } }),
				),
		],
		[
			'history is not replayed yet',
			() => mockGetNode.mockReturnValue(liveNode({ confirmedTransactionHistoryReady: false })),
		],
		[
			'our node shows the body confirmed',
			() => mockGetNode.mockReturnValue(liveNode({ getConfirmedTransaction: () => ({}) })),
		],
		['the head has no live connection', () => mockGetNode.mockReturnValue(null)],
		['the head is not open', () => mockHeadFindUnique.mockResolvedValue(openHead({ status: HydraHeadStatus.Closed }))],
		['the head is closing', () => mockHeadFindUnique.mockResolvedValue(openHead({ isClosing: true }))],
	])('is not releasable when %s', async (_case, arrange) => {
		arrange();

		const { reservations } = await listHeldL2Reservations('head-1', NOW_MS);
		expect(reservations[0].releasable).toBe(false);
		expect(reservations[0].blockedReason).toEqual(expect.any(String));
	});

	// The review finding: a row recovery can still prove was releasable at the
	// same grace recovery nudges at, so the admin took the risk for nothing.
	describe('grace before an admin may release', () => {
		const between =
			L2_RESERVATION_RELEASE_GRACE_MS + (L2_OPERATOR_RELEASE_GRACE_MS - L2_RESERVATION_RELEASE_GRACE_MS) / 2;
		const listOne = async (row: Record<string, unknown>) => {
			mockTransactionFindMany.mockResolvedValue([reservationRow(row)]);
			return (await listHeldL2Reservations('head-1', NOW_MS)).reservations[0];
		};

		it('holds a provable row while recovery still has nudge passes left', async () => {
			const reservation = await listOne({ invalidHereafterSlot: slotExpiredAgo(between) });
			expect(reservation.releasable).toBe(false);
			expect(reservation.blockedReason).toMatch(/Automatic recovery may still prove/);
		});

		it('releases a provable row once those passes are over', async () => {
			const reservation = await listOne({
				invalidHereafterSlot: slotExpiredAgo(L2_OPERATOR_RELEASE_GRACE_MS + 60_000),
			});
			expect(reservation.releasable).toBe(true);
		});

		it.each([
			[
				'an action with no value floor',
				{
					l2ReservationPreviousTransactionId: 'escrow-tx',
					PurchaseRequestCurrent: [],
					PaymentRequestCurrent: [{ id: 'payment-1' }],
				},
			],
			['a row with no recorded inputs', { l2ReservationInputRefs: [] }],
		])('releases %s after the release grace alone', async (_case, row) => {
			const reservation = await listOne({ ...row, invalidHereafterSlot: slotExpiredAgo(between) });
			expect(reservation.releasable).toBe(true);
		});
	});

	it('404s for an unknown head', async () => {
		mockHeadFindUnique.mockResolvedValue(null);

		await expect(listHeldL2Reservations('head-1', NOW_MS)).rejects.toMatchObject({ status: 404 });
	});
});

describe('releaseHeldL2Reservation', () => {
	it('releases the reviewed row as an operator release, guarded on the nudge it read', async () => {
		await expect(release()).resolves.toEqual({
			transactionId: 'tx-1',
			purchaseRequestIds: ['purchase-1'],
			paymentRequestIds: [],
		});

		expect(mockRelease).toHaveBeenCalledTimes(1);
		const [row, , proof] = mockRelease.mock.calls[0] as [{ id: string; l2ReleaseNudgeTx: unknown }, unknown, string];
		expect(proof).toBe('operator');
		expect(row).toEqual(expect.objectContaining({ id: 'tx-1', l2ReleaseNudgeTx: null }));
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ actorApiKeyId: 'admin-key', transactionId: 'tx-1' }),
		);
	});

	it('refuses a row that changed since the admin reviewed it', async () => {
		await expect(release({ expectedUpdatedAt: new Date(UPDATED_AT.getTime() + 1) })).rejects.toMatchObject({
			status: 409,
		});
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('refuses a body that is not provably expired', async () => {
		mockTransactionFindFirst.mockResolvedValue(reservationRow({ invalidHereafterSlot: LIVE_SLOT }));

		await expect(release()).rejects.toMatchObject({ status: 409 });
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('refuses a body our node shows confirmed', async () => {
		mockGetNode.mockReturnValue(liveNode({ getConfirmedTransaction: () => ({}) }));

		await expect(release()).rejects.toMatchObject({ status: 409 });
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it.each([
		['not open', openHead({ status: HydraHeadStatus.Final }), 409],
		['closing', openHead({ isClosing: true }), 409],
	])('refuses a head that is %s', async (_case, head, status) => {
		mockHeadFindUnique.mockResolvedValue(head);

		await expect(release()).rejects.toMatchObject({ status });
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('502s without a live connection', async () => {
		mockGetNode.mockReturnValue(null);

		await expect(release()).rejects.toMatchObject({ status: 502 });
	});

	it('404s for a row that is not a pending L2 reservation on this head', async () => {
		mockTransactionFindFirst.mockResolvedValue(null);

		await expect(release()).rejects.toMatchObject({ status: 404 });
		expect(mockTransactionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: 'tx-1', hydraHeadId: 'head-1', layer: 'L2', status: 'Pending' }),
			}),
		);
	});

	// A reconnect between the checks could replay a confirmation of the body.
	it('refuses when the head session changed during the checks', async () => {
		mockGetNode.mockReturnValueOnce(liveNode()).mockReturnValue(liveNode());

		await expect(release()).rejects.toMatchObject({ status: 409 });
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('409s, not 500s, when a concurrent write aborts the serializable release', async () => {
		const { Prisma } = await import('@/generated/prisma/client');
		mockRelease.mockRejectedValue(
			new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' }),
		);

		await expect(release()).rejects.toMatchObject({ status: 409 });
	});

	it('409s when the guarded release finds the row resolved or unmappable', async () => {
		mockRelease.mockResolvedValue(false);

		await expect(release()).rejects.toMatchObject({ status: 409 });
	});
});
