import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockUpdateMany = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraDecommit: { updateMany: mockUpdateMany } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { applyDecommitOutcome } = await import('./settle');

const HEAD = 'head-1';
const TX = 'a'.repeat(64);

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 });
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

		expect(mockUpdateMany).toHaveBeenCalledTimes(2);
		expect(mockUpdateMany.mock.calls[0]![0].data.status).toBe('Finalized');
		// Scoped to rows that never recorded one, so a real approval time is kept.
		expect(mockUpdateMany.mock.calls[1]![0].where.approvedAt).toBeNull();
		expect(mockUpdateMany.mock.calls[1]![0].data.approvedAt).toBeInstanceOf(Date);
	});

	// Finalization can arrive for a row already at Approved, which is the normal
	// order, so Approved has to remain a status it can move away from.
	it('finalizes a withdrawal that was already approved', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' });

		expect(statusFilter()).toContain('Approved');
	});

	// Replay means the same event can be seen more than once.
	it('reports no change when nothing matched', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });

		expect(await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'approved' })).toBe(false);
	});

	// A withdrawal belongs to one head; an event from another must never move it.
	it('scopes every write to the head that reported it', async () => {
		await applyDecommitOutcome({ hydraHeadId: HEAD, decommitTxId: TX, outcome: 'finalized' });

		for (const call of mockUpdateMany.mock.calls) {
			expect(call[0].where.hydraHeadId).toBe(HEAD);
		}
	});
});
