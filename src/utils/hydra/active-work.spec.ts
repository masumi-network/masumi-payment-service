import type { Prisma } from '@/generated/prisma/client';
import { PREPARING_STALE_AFTER_MS } from '@/services/hydra-topup/stale';
import { countHydraHeadActiveWork, hasActiveWork } from '@/utils/hydra/active-work';

type CountArgs = { where: Record<string, unknown> };

/** A client that records what it was asked and answers with fixed counts. */
function fakeClient(counts: {
	transactions: number;
	payments: number;
	purchases: number;
	topups?: number;
	pendingCommitTxHash?: string;
	recordedCommitRows?: number;
}) {
	const calls: Record<string, CountArgs> = {};
	const client = {
		transaction: {
			count: async (args: CountArgs) => {
				calls.transaction = args;
				return counts.transactions;
			},
		},
		paymentRequest: {
			count: async (args: CountArgs) => {
				calls.paymentRequest = args;
				return counts.payments;
			},
		},
		purchaseRequest: {
			count: async (args: CountArgs) => {
				calls.purchaseRequest = args;
				return counts.purchases;
			},
		},
		hydraTopup: {
			count: async (args: CountArgs) => {
				if ('depositTxHash' in args.where && typeof args.where.depositTxHash === 'string') {
					calls.recordedCommit = args;
					return counts.recordedCommitRows ?? 0;
				}
				calls.hydraTopup = args;
				return counts.topups ?? 0;
			},
		},
		hydraLocalParticipant: {
			findFirst: async () => (counts.pendingCommitTxHash == null ? null : { commitTxHash: counts.pendingCommitTxHash }),
		},
	} as unknown as Prisma.TransactionClient;

	return { client, calls };
}

describe('countHydraHeadActiveWork', () => {
	it('sums escrows across both sides of the trade', async () => {
		const { client } = fakeClient({ transactions: 2, payments: 3, purchases: 4 });

		expect(await countHydraHeadActiveWork(client, 'head-1')).toEqual({
			pendingL2Transactions: 2,
			activeEscrows: 7,
			unrecoveredDeposits: 0,
		});
	});

	// Closing does NOT settle these. An unabsorbed deposit is not part of the
	// fanout — it comes back only through Recover, which needs a live session for
	// the head — so a close waved through leaves the money at the deposit script
	// with nothing left able to ask for it back.
	it('counts deposits the head has neither absorbed nor returned', async () => {
		const { client, calls } = fakeClient({ transactions: 0, payments: 0, purchases: 0, topups: 2 });

		const work = await countHydraHeadActiveWork(client, 'head-1');

		expect(work.unrecoveredDeposits).toBe(2);
		expect(calls.hydraTopup.where).toMatchObject({
			hydraHeadId: 'head-1',
			OR: expect.arrayContaining([
				{ depositTxHash: { not: null }, status: { notIn: ['Absorbed', 'Recovered', 'Failed'] } },
			]) as unknown[],
		});
	});

	// A top-up is Preparing while its carve confirms; its deposit reaches L1
	// later. A close admitted in that gap would let the deposit land after it.
	it('counts a top-up still being prepared, but not an abandoned one', async () => {
		const { client, calls } = fakeClient({ transactions: 0, payments: 0, purchases: 0 });

		await countHydraHeadActiveWork(client, 'head-1');

		const preparing = (calls.hydraTopup.where.OR as Array<Record<string, unknown>>).find(
			(clause) => clause.status === 'Preparing',
		);
		// The same cutoff the top-up claim uses to fail an abandoned row.
		const cutoff = (preparing?.createdAt as { gte: Date }).gte.getTime();
		expect(Math.abs(Date.now() - PREPARING_STALE_AFTER_MS - cutoff)).toBeLessThan(5_000);
	});

	// The initial commit is reserved on the participant before submission and
	// only gets its deposit row after. In between, only the reservation shows it.
	it('counts a reserved initial commit once, whether or not its row exists yet', async () => {
		const unrecorded = fakeClient({ transactions: 0, payments: 0, purchases: 0, pendingCommitTxHash: 'c'.repeat(64) });
		expect((await countHydraHeadActiveWork(unrecorded.client, 'head-1')).unrecoveredDeposits).toBe(1);

		const recorded = fakeClient({
			transactions: 0,
			payments: 0,
			purchases: 0,
			topups: 1,
			pendingCommitTxHash: 'c'.repeat(64),
			recordedCommitRows: 1,
		});
		expect((await countHydraHeadActiveWork(recorded.client, 'head-1')).unrecoveredDeposits).toBe(1);
	});

	// `Failed` reads like the opposite of settled and is not. Both writers that
	// set it with a deposit hash prove the output does not exist: a phase-2
	// failure creates no outputs, and the other branch fires only once a trusted
	// slot is past the signed TTL with the hash still absent, after which that
	// transaction can never be included.
	//
	// Counting it made every failed top-up permanent. Nothing can clear the row —
	// the recovery reconciler resolves a deposit by watching its output be spent,
	// and an output that was never created is never spent — so the head, its
	// participants and their relations could not be deleted, ever.
	it('does not count a failed deposit as money left at the script', async () => {
		const { client, calls } = fakeClient({ transactions: 0, payments: 0, purchases: 0, topups: 0 });

		await countHydraHeadActiveWork(client, 'head-1');

		expect(calls.hydraTopup.where).toMatchObject({
			OR: expect.arrayContaining([
				expect.objectContaining({ status: { notIn: expect.arrayContaining(['Failed']) as string[] } }),
			]) as unknown[],
		});
	});

	// Both sides have to be counted the same way. Asking them differently is how
	// a head reads as empty from one endpoint and busy from the other.
	it('asks the same question of payments and purchases', async () => {
		const { client, calls } = fakeClient({ transactions: 0, payments: 0, purchases: 0 });

		await countHydraHeadActiveWork(client, 'head-1');

		expect(calls.paymentRequest).toEqual(calls.purchaseRequest);
		expect(calls.paymentRequest.where).toMatchObject({
			layer: 'L2',
			CurrentTransaction: { is: { hydraHeadId: 'head-1', layer: 'L2' } },
		});
	});

	it('counts only this head and only unconfirmed L2 transactions', async () => {
		const { client, calls } = fakeClient({ transactions: 0, payments: 0, purchases: 0 });

		await countHydraHeadActiveWork(client, 'head-1');

		expect(calls.transaction.where).toEqual({
			hydraHeadId: 'head-1',
			layer: 'L2',
			status: 'Pending',
		});
	});
});

describe('hasActiveWork', () => {
	it('is false only when the head holds nothing', () => {
		expect(hasActiveWork({ pendingL2Transactions: 0, activeEscrows: 0, unrecoveredDeposits: 0 })).toBe(false);
		expect(hasActiveWork({ pendingL2Transactions: 1, activeEscrows: 0, unrecoveredDeposits: 0 })).toBe(true);
		expect(hasActiveWork({ pendingL2Transactions: 0, activeEscrows: 1, unrecoveredDeposits: 0 })).toBe(true);
		// The one closing cannot settle, so it has to block the same way.
		expect(hasActiveWork({ pendingL2Transactions: 0, activeEscrows: 0, unrecoveredDeposits: 1 })).toBe(true);
	});
});
