import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockUpdateMany = jest.fn() as AnyMock;
const mockFindMany = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraDecommit: { updateMany: mockUpdateMany, findMany: mockFindMany } },
}));

// Identifying the payout is a chain lookup that runs after the status is
// written and must never be what decides it.
const mockResolvePayout = jest.fn() as AnyMock;
jest.unstable_mockModule('./payout-lookup', () => ({ resolveDecommitPayoutTx: mockResolvePayout }));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { applyDecommitOutcome } = await import('./settle');
const { PENDING_EXPIRED_REASONS } = await import('./stale');

const HEAD = 'head-1';
const TX = 'a'.repeat(64);

const OBSERVED_AT = new Date('2026-08-05T22:37:49.553Z');

const OPEN_ROW = { id: 'decommit-1', approvedAt: null, l1TxId: null };

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockFindMany.mockResolvedValue([OPEN_ROW]);
	mockResolvePayout.mockResolvedValue(undefined);
});

function finalizationWhere(): any {
	return mockFindMany.mock.calls[0]![0].where;
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

	// A peer can send a different witness set for the same transaction body.
	// The body hash matches our pending row, but the peer's rejected submission
	// says nothing about whether the locally signed one will be approved.
	it('does not fail a local withdrawal when a same-id submission is rejected', async () => {
		expect(
			await applyDecommitOutcome({
				hydraHeadId: HEAD,
				decommitTxId: TX,
				outcome: 'invalid',
				reason: 'ValueNotConservedUTxO',
			}),
		).toBe(false);

		expect(mockUpdateMany).not.toHaveBeenCalled();
		expect(mockFindMany).not.toHaveBeenCalled();
		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'approved' })).toBe(true);
		expect(mockUpdateMany.mock.calls[0]![0].data.status).toBe('Approved');
	});

	// A replay starting mid-history must still record the head's approval,
	// while independent L1 proof remains outstanding.
	it('stamps the approval when finalization is seen without it', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' });

		const data = mockUpdateMany.mock.calls[0]![0].data;
		expect(data.status).toBe('Approved');
		expect(data.l1ObservedAt).toBeInstanceOf(Date);
		expect(data.finalizedAt).toBeUndefined();
		expect(data.approvedAt).toBeInstanceOf(Date);
	});

	// A real approval time must survive: only a row that never recorded one gets
	// the finalization's timestamp put in its place.
	it('keeps an approval time it already had', async () => {
		mockFindMany.mockResolvedValue([{ ...OPEN_ROW, approvedAt: new Date('2026-01-01T00:00:00Z') }]);

		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' });

		expect(mockUpdateMany.mock.calls[0]![0].data.approvedAt).toBeUndefined();
	});

	// Exact identity permits replay to repair a row whose earlier anonymous
	// finalization stored a peer's amount. Independent L1 proof still gates finality.
	it('accepts the exact named finalization for an already observed Approved row', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' });

		expect(finalizationWhere()).toMatchObject({ hydraHeadId: HEAD, decommitTxId: TX });
		expect(finalizationWhere().OR[0].status.in).toContain('Approved');
		expect(finalizationWhere()).not.toHaveProperty('l1ObservedAt');
	});

	// A timestamp after the local approval can also belong to a peer withdrawal.
	// The stream must correlate its approval before this writer sees it.
	it('ignores an unnamed finalization even when exactly one Approved row exists', async () => {
		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized', observedAt: OBSERVED_AT })).toBe(
			false,
		);
		expect(mockFindMany).not.toHaveBeenCalled();
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('attributes a named finalization to an Approved withdrawal with no approval time', async () => {
		mockFindMany.mockResolvedValue([{ ...OPEN_ROW, status: 'Approved', approvedAt: null }]);
		expect(
			await applyDecommitOutcome({
				hydraHeadId: HEAD,
				decommitTxId: TX,
				outcome: 'finalized',
				observedAt: OBSERVED_AT,
			}),
		).toBe(true);
		expect(mockUpdateMany.mock.calls[0]![0].data.status).toBe('Approved');
		expect(mockUpdateMany.mock.calls[0]![0].data.approvedAt).toBeInstanceOf(Date);
	});

	it('ignores an unnamed finalization that carries no timestamp', async () => {
		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized' })).toBe(false);
		expect(mockFindMany).not.toHaveBeenCalled();
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('matches a named finalization without an event timestamp by its exact identity', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' });
		expect(finalizationWhere()).toMatchObject({ hydraHeadId: HEAD, decommitTxId: TX });
		expect(finalizationWhere()).not.toHaveProperty('approvedAt');
	});

	// What arrives can differ from what was asked for: a decommit takes whole
	// outputs and the L1 decrement's fee comes out of the value that travels.
	// Recorded beside the request, never over it, so the difference stays visible.
	it('records what actually landed when the head says so', async () => {
		await applyDecommitOutcome({
			hydraHeadId: HEAD,
			decommitTxId: TX,
			outcome: 'finalized',
			observedAt: OBSERVED_AT,
			distributed: { lovelace: 4_829_879n, assets: { '67ab': '1' } },
		});

		const data = mockUpdateMany.mock.calls[0]![0].data;
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
		expect(mockUpdateMany.mock.calls[0]![0].where.id).toBe(OPEN_ROW.id);
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
		const finalization = applyDecommitOutcome({
			hydraHeadId: HEAD,
			decommitTxId: TX,
			outcome: 'finalized',
			observedAt: OBSERVED_AT,
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(mockFindMany).not.toHaveBeenCalled();

		releaseApproval({ count: 1 });
		await Promise.all([approval, finalization]);
		expect(mockFindMany).toHaveBeenCalledTimes(1);
	});

	it('finalizes an expired row when the finalization names it, and clears the expiry', async () => {
		mockFindMany.mockResolvedValue([{ ...OPEN_ROW, approvedAt: null }]);

		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' })).toBe(true);

		expect(finalizationWhere()).toEqual({
			hydraHeadId: HEAD,
			decommitTxId: TX,
			OR: [{ status: { in: ['Preparing', 'Pending', 'Approved'] } }, EXPIRED_CLAUSE],
		});
		expect(mockUpdateMany.mock.calls[0]![0].data).toMatchObject({ status: 'Approved', failureReason: null });
	});

	// An unnamed finalization could belong to any withdrawal of the head: a
	// replayed one from a later request would otherwise mark the expired row paid.
	it('never attributes an unnamed finalization to an expired row', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized', observedAt: OBSERVED_AT });

		expect(mockFindMany).not.toHaveBeenCalled();
	});
});
