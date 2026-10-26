import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { HydraSnapshotRound } from '@/lib/hydra/hydra/node-control-queries';

const now = new Date('2026-10-16T12:00:00Z');
const round: HydraSnapshotRound = {
	inFlight: true,
	tag: 'SeenSnapshot',
	number: 314,
	signatoryCount: 1,
	txIds: ['a'.repeat(64)],
	signature: 'SeenSnapshot|314|1',
};

type Head = {
	id: string;
	snapshotRoundSignature: string | null;
	snapshotRoundSince: Date | null;
	snapshotRoundAlertedAt: Date | null;
};
type Delivery = { webhookEndpointId: string; eventType: string };
let head: Head;
let deliveries: Delivery[];
let failure: 'endpoint-query' | 'delivery-insert' | null;

const database = {
	hydraHead: {
		findUnique: async ({ where }: { where: { id: string } }) =>
			where.id === head.id
				? {
						HydraRelation: { localHotWalletId: 'wallet-1', LocalHotWallet: { paymentSourceId: 'source-1' } },
						LocalParticipant: { id: 'participant-1', walletId: 'wallet-1' },
					}
				: null,
		updateMany: async ({ where, data }: { where: Partial<Head>; data: Partial<Head> }) => {
			const matches = Object.entries(where).every(([key, value]) => {
				const stored = head[key as keyof Head];
				if ((key === 'snapshotRoundSince' || key === 'snapshotRoundAlertedAt') && stored != null && value != null) {
					return Number(stored) === Number(value);
				}
				return stored === value;
			});
			if (!matches) return { count: 0 };
			Object.assign(head, data);
			return { count: 1 };
		},
	},
	webhookEndpoint: {
		findMany: async () => {
			if (failure === 'endpoint-query') {
				failure = null;
				throw new Error('database read temporarily failed');
			}
			return [{ id: 'endpoint-1' }, { id: 'endpoint-2' }];
		},
	},
	webhookDelivery: {
		create: async ({ data }: { data: Delivery }) => {
			if (failure === 'delivery-insert' && deliveries.length === 1) {
				failure = null;
				throw new Error('database insert temporarily failed');
			}
			deliveries.push(data);
		},
	},
};

const prisma = {
	...database,
	$transaction: async (callback: (tx: typeof database) => Promise<unknown>) => {
		const before = structuredClone({ head, deliveries });
		try {
			return await callback(database);
		} catch (error) {
			head = before.head;
			deliveries = before.deliveries;
			throw error;
		}
	},
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma }));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: () => null }),
}));
jest.unstable_mockModule('@/services/webhooks/sender.service', () => ({
	webhookSenderService: {
		sendWebhook: async () => {
			throw new Error('This regression must not send a webhook');
		},
	},
}));

const { applySnapshotRoundObservation } = await import('./watch');

beforeEach(() => {
	head = {
		id: 'head-1',
		snapshotRoundSignature: round.signature,
		snapshotRoundSince: new Date(now.getTime() - 15 * 60_000),
		snapshotRoundAlertedAt: null,
	};
	deliveries = [];
	failure = null;
});

describe('stuck snapshot alert outbox', () => {
	it('rejects an old alert tick after a reset restarts the same round signature', async () => {
		const beforeReset = structuredClone(head);
		head.snapshotRoundSince = new Date(now.getTime() - 60_000);

		await applySnapshotRoundObservation(beforeReset, round, now);

		expect(head.snapshotRoundAlertedAt).toBeNull();
		expect(deliveries).toEqual([]);
	});

	it.each(['endpoint-query', 'delivery-insert'] as const)(
		'retries the alert after a transient %s failure without partial or duplicate deliveries',
		async (failedBoundary) => {
			failure = failedBoundary;
			// The scheduler catches this tick's error and tries the same round again.
			await applySnapshotRoundObservation(structuredClone(head), round, now).catch(() => undefined);

			expect(head.snapshotRoundAlertedAt).toBeNull();
			expect(deliveries).toEqual([]);
			await applySnapshotRoundObservation(structuredClone(head), round, now);
			await applySnapshotRoundObservation(structuredClone(head), round, now);

			expect(head.snapshotRoundAlertedAt).toEqual(now);
			expect(deliveries.map((delivery) => delivery.webhookEndpointId)).toEqual(['endpoint-1', 'endpoint-2']);
		},
	);
});
