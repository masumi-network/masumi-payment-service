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

/** The status filter the call was made with, whatever shape it took. */
function statusFilter(callIndex = 0): string[] {
	const where = mockUpdateMany.mock.calls[callIndex]![0].where;
	return where.status?.in ?? [];
}

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

		expect(mockFindMany.mock.calls[0]![0].where.status.in).toContain('Approved');
	});

	// The head reports finalization without naming a withdrawal, so the row is
	// found by head alone. Requiring an id here dropped every finalization and
	// left settled withdrawals reading as still paying out.
	it('finalizes a withdrawal the head did not name', async () => {
		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized' })).toBe(true);

		expect(mockFindMany.mock.calls[0]![0].where.decommitTxId).toBeUndefined();
		expect(mockUpdate.mock.calls[0]![0].data.status).toBe('Finalized');
	});

	// A head replays its whole history on every reconnection, so a finalization
	// from an earlier withdrawal arrives again beside today's pending one. Without
	// the age filter the old event marks the new withdrawal paid out while its
	// funds are still in the head.
	it('only considers withdrawals that existed when the head produced the event', async () => {
		const observedAt = new Date('2026-08-05T22:37:49.553Z');

		await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized', observedAt });

		// Filtered on the approval, which a finalization can never precede.
		expect(mockFindMany.mock.calls[0]![0].where.approvedAt).toEqual({ lte: observedAt });
	});

	// Older heads report no timestamp; the filter is dropped rather than being
	// applied against a guessed time.
	it('does not filter by age when the head reported no timestamp', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, outcome: 'finalized' });

		expect(mockFindMany.mock.calls[0]![0].where.approvedAt).toBeUndefined();
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
