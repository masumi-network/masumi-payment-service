import type { Prisma } from '@/generated/prisma/client';
import { countHydraHeadActiveWork, hasActiveWork } from '@/utils/hydra/active-work';

type CountArgs = { where: Record<string, unknown> };

/** A client that records what it was asked and answers with fixed counts. */
function fakeClient(counts: { transactions: number; payments: number; purchases: number }) {
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
	} as unknown as Prisma.TransactionClient;

	return { client, calls };
}

describe('countHydraHeadActiveWork', () => {
	it('sums escrows across both sides of the trade', async () => {
		const { client } = fakeClient({ transactions: 2, payments: 3, purchases: 4 });

		expect(await countHydraHeadActiveWork(client, 'head-1')).toEqual({
			pendingL2Transactions: 2,
			activeEscrows: 7,
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
		expect(hasActiveWork({ pendingL2Transactions: 0, activeEscrows: 0 })).toBe(false);
		expect(hasActiveWork({ pendingL2Transactions: 1, activeEscrows: 0 })).toBe(true);
		expect(hasActiveWork({ pendingL2Transactions: 0, activeEscrows: 1 })).toBe(true);
	});
});
