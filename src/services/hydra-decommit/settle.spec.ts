import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockUpdateMany = jest.fn() as AnyMock;
const mockFindMany = jest.fn() as AnyMock;
const mockUpdate = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraDecommit: { updateMany: mockUpdateMany, findMany: mockFindMany, update: mockUpdate } },
}));

// Identifying the payout is a chain lookup that runs after the status is
// written and must never be what decides it.
const mockResolvePayout = jest.fn() as AnyMock;
jest.unstable_mockModule('./payout-lookup', () => ({ resolveDecommitPayoutTx: mockResolvePayout }));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { applyDecommitOutcome } = await import('./settle');
const { PENDING_EXPIRED_REASON, PENDING_EXPIRED_REASONS } = await import('./stale');

const HEAD = 'head-1';
const TX = 'a'.repeat(64);

const OPEN_ROW = { id: 'decommit-1', approvedAt: null, l1TxId: null };

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockFindMany.mockResolvedValue([OPEN_ROW]);
	mockUpdate.mockResolvedValue(OPEN_ROW);
	mockResolvePayout.mockResolvedValue(undefined);
});

/** The open statuses the call was made with, whatever shape it took. */
function statusFilter(callIndex = 0): string[] {
	const where = mockUpdateMany.mock.calls[callIndex]![0].where;
	return where.OR?.[0]?.status?.in ?? where.status?.in ?? [];
}

/** The finalization lookup's clauses, which are ANDed together. */
function findClauses(callIndex = 0): any[] {
	return mockFindMany.mock.calls[callIndex]![0].where.AND;
}

/** The clause that lets an outcome reach a row this service expired. */
const EXPIRED_CLAUSE = { status: 'Failed', failureReason: { in: PENDING_EXPIRED_REASONS } };

describe('applyDecommitOutcome', () => {
	it('records an approval and when it happened', async () => {
		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'approved' })).toBe(true);

		const call = mockUpdateMany.mock.calls[0]![0];
		expect(call.data.status).toBe('Approved');
		expect(call.data.approvedAt).toBeInstanceOf(Date);
		expect(call.where.hydraHeadId).toBe(HEAD);
		expect(call.where.decommitTxId).toBe(TX);
	});

	// The point of no return. A refusal arriving after the head has signed the
	// removal would otherwise report money as still in the head when it is not.
	it('never lets a late refusal undo an approval', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'invalid', reason: 'too late' });

		expect(statusFilter()).toEqual(['Preparing', 'Pending']);
		expect(statusFilter()).not.toContain('Approved');
	});

	it('keeps the head’s own wording when it refuses', async () => {
		await applyDecommitOutcome({
			hydraHeadId: HEAD,
			decommitTxId: TX,
			outcome: 'invalid',
			reason: 'ValueNotConservedUTxO',
		});

		expect(mockUpdateMany.mock.calls[0]![0].data.failureReason).toBe('ValueNotConservedUTxO');
	});

	it('falls back to a plain reason when the node gave none', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'invalid' });

		expect(mockUpdateMany.mock.calls[0]![0].data.failureReason).toContain('refused');
	});

	// A replay starting mid-history, or a restart between the two events, would
	// otherwise leave a finalized withdrawal claiming it was never approved.
	it('stamps the approval when finalization is seen without it', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' });

		const data = mockUpdate.mock.calls[0]![0].data;
		expect(data.status).toBe('Finalized');
		expect(data.approvedAt).toBeInstanceOf(Date);
	});

	// A real approval time must survive: only a row that never recorded one gets
	// the finalization's timestamp put in its place.
	it('keeps an approval time it already had', async () => {
		mockFindMany.mockResolvedValue([{ ...OPEN_ROW, approvedAt: new Date('2026-01-01T00:00:00Z') }]);

		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' });

		expect(mockUpdate.mock.calls[0]![0].data.approvedAt).toBeUndefined();
	});

	// Finalization can arrive for a row already at Approved, which is the normal
	// order, so Approved has to remain a status it can move away from.
	it('finalizes a withdrawal that was already approved', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' });

		expect(findClauses()[0].OR[0].status.in).toContain('Approved');
	});

	// The head reports finalization without naming a withdrawal, so the row is
	// found by head alone. Requiring an id here dropped every finalization and
	// left settled withdrawals reading as still paying out.
	it('finalizes a withdrawal the head did not name', async () => {
		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized' })).toBe(true);

		expect(findClauses()[0].decommitTxId).toBeUndefined();
		expect(mockUpdate.mock.calls[0]![0].data.status).toBe('Finalized');
	});

	// A head replays its whole history on every reconnection, so a finalization
	// from an earlier withdrawal arrives again beside today's pending one. Without
	// the age filter the old event marks the new withdrawal paid out while its
	// funds are still in the head.
	it('only considers withdrawals that existed when the head produced the event', async () => {
		const observedAt = new Date('2026-08-05T22:37:49.553Z');

		await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized', observedAt });

		// Filtered on the approval, which a finalization can never precede — and,
		// for a row whose approval was never written, on when the row was created,
		// since `approvedAt: { lte: … }` matches no NULL and would otherwise leave
		// that withdrawal open with its funds already on L1.
		expect(findClauses()[1].OR).toEqual([
			{ approvedAt: { lte: observedAt } },
			{ approvedAt: null, createdAt: { lte: observedAt } },
		]);
	});

	// The row the stamping branch below was written for: approved but never
	// recorded as approved, which is what a missed frame or a failed write leaves.
	it('attributes a finalization to a withdrawal whose approval was never written', async () => {
		const observedAt = new Date('2026-08-05T22:37:49.553Z');
		mockFindMany.mockResolvedValue([{ ...OPEN_ROW, approvedAt: null }]);

		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized', observedAt })).toBe(true);
		expect(mockUpdate.mock.calls[0]![0].data.status).toBe('Finalized');
		expect(mockUpdate.mock.calls[0]![0].data.approvedAt).toBeInstanceOf(Date);
	});

	// Older heads report no timestamp; the filter is dropped rather than being
	// applied against a guessed time.
	it('does not filter by age when the head reported no timestamp', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized' });

		expect(findClauses()).toHaveLength(1);
	});

	// Guessing wrong marks the wrong withdrawal paid out, which is worse than
	// leaving both alone until a named event arrives.
	it('refuses to attribute an unnamed finalization when several are open', async () => {
		mockFindMany.mockResolvedValue([OPEN_ROW, { ...OPEN_ROW, id: 'decommit-2' }]);

		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized' })).toBe(false);
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	// What arrives can differ from what was asked for: a decommit takes whole
	// outputs and the L1 decrement's fee comes out of the value that travels.
	// Recorded beside the request, never over it, so the difference stays visible.
	it('records what actually landed when the head says so', async () => {
		await applyDecommitOutcome({
			hydraHeadId: HEAD,
			outcome: 'finalized',
			distributed: { lovelace: 4_829_879n, assets: { '67ab': '1' } },
		});

		const data = mockUpdate.mock.calls[0]![0].data;
		expect(data.settledLovelace).toBe(4_829_879n);
		expect(data.settledAssets).toEqual({ '67ab': '1' });
		// The record of intent survives, which is what makes a surprise noticeable.
		expect(data.requestedLovelace).toBeUndefined();
		expect(data.requestedAssets).toBeUndefined();
	});

	it('reports no change when no withdrawal was open', async () => {
		mockFindMany.mockResolvedValue([]);

		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' })).toBe(false);
	});

	// Replay means the same event can be seen more than once.
	it('reports no change when nothing matched', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });

		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'approved' })).toBe(false);
	});

	// A withdrawal belongs to one head; an event from another must never move it.
	it('scopes every write to the head that reported it', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' });

		expect(mockFindMany.mock.calls[0]![0].where.hydraHeadId).toBe(HEAD);
		expect(mockUpdate.mock.calls[0]![0].where.id).toBe(OPEN_ROW.id);
	});
});

/**
 * F5: a Pending row expired by age, then answered by the head.
 *
 * Expiry is this service's guess that the head never took the request. When the
 * head's own answer for that transaction arrives late, after a reconnect replays
 * it, the guess must give way, or the row reads "failed" for funds the head
 * approved and paid out. Only an outcome that names the transaction may do this.
 */
describe('applyDecommitOutcome on an expired withdrawal', () => {
	it('lets a late approval of the same transaction replace the expiry', async () => {
		mockUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'approved' })).toBe(true);

		const revive = mockUpdateMany.mock.calls[1]![0];
		expect(revive.where).toEqual({ hydraHeadId: HEAD, decommitTxId: TX, ...EXPIRED_CLAUSE });
		expect(revive.data).toEqual({ status: 'Approved', failureReason: null });
	});

	// Reviewer finding: the approval reaches an expired row only by replay, and
	// the replayed finalization after it carries the old frame time. A revive
	// stamped with the replay time sits after that, so the finalization never
	// matched and the row stayed Approved, refusing every later withdrawal.
	it('leaves the approval time empty on a revived row so the replayed finalization still matches', async () => {
		mockUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'approved' });

		expect(mockUpdateMany.mock.calls[1]![0].data).not.toHaveProperty('approvedAt');
	});

	// Outcomes are emitted fire-and-forget. A finalization that read its rows
	// before the replayed approval re-opened the expired row would miss it.
	it('applies a head’s outcomes one at a time, in the order they arrived', async () => {
		let releaseApproval!: (value: { count: number }) => void;
		mockUpdateMany.mockReturnValueOnce(new Promise((resolve) => (releaseApproval = resolve)));

		const approval = applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'approved' });
		const finalization = applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized' });
		await new Promise((resolve) => setImmediate(resolve));
		expect(mockFindMany).not.toHaveBeenCalled();

		releaseApproval({ count: 1 });
		await Promise.all([approval, finalization]);
		expect(mockFindMany).toHaveBeenCalledTimes(1);
	});

	it('lets a late refusal of the same transaction record the head’s reason', async () => {
		await applyDecommitOutcome({
			hydraHeadId: HEAD,
			decommitTxId: TX,
			outcome: 'invalid',
			reason: 'DecommitTxInvalid',
		});

		const call = mockUpdateMany.mock.calls[0]![0];
		expect(call.where.OR).toContainEqual(EXPIRED_CLAUSE);
		expect(call.data.failureReason).toBe('DecommitTxInvalid');
	});

	// A refusal from the node or the head is final. Only the expiry marker opens
	// a Failed row, so a real failure can never be turned into an approval.
	it('reopens only rows failed by expiry, never a real failure', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'invalid' });

		const failedClauses = mockUpdateMany.mock.calls[0]![0].where.OR.filter((clause: any) => clause.status === 'Failed');
		expect(failedClauses).toEqual([EXPIRED_CLAUSE]);
		expect(PENDING_EXPIRED_REASONS).toContain(PENDING_EXPIRED_REASON);
		// Rows expired before the node was asked carry the older wording.
		expect(PENDING_EXPIRED_REASONS).toContain('the head never answered the withdrawal request');
	});

	it('finalizes an expired row when the finalization names it, and clears the expiry', async () => {
		mockFindMany.mockResolvedValue([{ ...OPEN_ROW, approvedAt: null }]);

		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' })).toBe(true);

		expect(findClauses()[0]).toEqual({
			decommitTxId: TX,
			OR: [{ status: { in: ['Preparing', 'Pending', 'Approved'] } }, EXPIRED_CLAUSE],
		});
		expect(mockUpdate.mock.calls[0]![0].data).toMatchObject({ status: 'Finalized', failureReason: null });
	});

	// An unnamed finalization could belong to any withdrawal of the head: a
	// replayed one from a later request would otherwise mark the expired row paid.
	it('never attributes an unnamed finalization to an expired row', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized' });

		expect(findClauses()[0]).toEqual({ status: { in: ['Preparing', 'Pending', 'Approved'] } });
	});
});
