import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockUpdateMany = jest.fn() as AnyMock;
const mockErrorCreate = jest.fn() as AnyMock;
const mockQueue = jest.fn() as AnyMock;

type StoredGap = {
	observationGapSince: Date | null;
	observationGapAlertedAt: Date | null;
	observationCheckedAt: Date | null;
};
/** The head row as the database holds it; a failed transaction restores it. */
let row: StoredGap = { observationGapSince: null, observationGapAlertedAt: null, observationCheckedAt: null };

const database = {
	hydraHead: { updateMany: mockUpdateMany },
	hydraHeadError: { create: mockErrorCreate },
};
const prisma = {
	...database,
	$transaction: async (callback: (tx: typeof database) => Promise<unknown>) => {
		const before = structuredClone(row);
		try {
			return await callback(database);
		} catch (error) {
			row = before;
			throw error;
		}
	},
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma }));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: { queueHydraHeadUnobservedInTransaction: mockQueue },
}));

let gap: typeof import('./observation-gap');

beforeAll(async () => {
	gap = await import('./observation-gap');
});

const NOW = new Date('2026-10-27T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const none: StoredGap = { observationGapSince: null, observationGapAlertedAt: null, observationCheckedAt: null };
/** A gap that began `minutes` ago and was last checked one minute ago. */
const since = (minutes: number): StoredGap => ({
	observationGapSince: minutesAgo(minutes),
	observationGapAlertedAt: null,
	observationCheckedAt: minutesAgo(1),
});
const DOWN = 'the node has no verified live session for this head';
const DAY_SECONDS = 86_400n;
const GRACE_MS = 5 * 60_000;

/** A conditional updateMany against `row`, the way Postgres applies it. */
function applyConditionalUpdate({ where, data }: { where: Partial<StoredGap>; data: Partial<StoredGap> }) {
	const matches = (Object.keys(where) as (keyof StoredGap | 'id')[])
		.filter((key): key is keyof StoredGap => key !== 'id')
		.every((key) => (row[key]?.getTime() ?? null) === (where[key]?.getTime() ?? null));
	if (!matches) return { count: 0 };
	row = { ...row, ...data };
	return { count: 1 };
}

beforeEach(() => {
	jest.clearAllMocks();
	row = { ...none };
	mockUpdateMany.mockImplementation(async (args: never) => applyConditionalUpdate(args));
	mockErrorCreate.mockResolvedValue({} as never);
	mockQueue.mockResolvedValue(undefined as never);
});

const head = (stored: StoredGap, contestationPeriod = DAY_SECONDS) => ({
	id: 'head-1',
	status: HydraHeadStatus.Closed,
	contestationPeriod,
	contestationDeadline: new Date('2026-10-28T12:00:00.000Z'),
	...stored,
});

const node = (
	overrides: Partial<{ status: HydraHeadStatus; hasVerifiedPinnedSessions: boolean; synced?: boolean }>,
) => {
	const { synced = true, ...rest } = overrides;
	return {
		status: HydraHeadStatus.Open,
		hasVerifiedPinnedSessions: true,
		isChainSynced: () => synced,
		...rest,
	};
};

/** One watch tick per minute while the node stays down; returns the last decision. */
async function tickEveryMinute(minutes: number) {
	let decision;
	for (let minute = 1; minute <= minutes; minute += 1) {
		decision = await gap.applyObservationGap(head(row), DOWN, new Date(NOW.getTime() + minute * 60_000));
	}
	return decision;
}

describe('nodeUnobservedReason', () => {
	it('counts a node that follows the head and the chain as observed', () => {
		expect(gap.nodeUnobservedReason(node({}))).toBeNull();
		expect(gap.nodeUnobservedReason(node({ status: HydraHeadStatus.Final }))).toBeNull();
		expect(gap.nodeUnobservedReason({ ...node({}), isChainSynced: () => undefined })).toBeNull();
	});

	// A lost socket leaves the last status in place, so Open alone proves nothing.
	it('does not count a node whose live session is gone, whatever status it last reported', () => {
		expect(gap.nodeUnobservedReason(node({ hasVerifiedPinnedSessions: false }))).toBe(DOWN);
	});

	it('does not count a node that lost the head or the chain', () => {
		expect(gap.nodeUnobservedReason(node({ status: HydraHeadStatus.Idle }))).toContain('Idle');
		expect(gap.nodeUnobservedReason(node({ synced: false }))).toBe('the node does not follow the chain');
	});
});

describe('observationGraceMs', () => {
	it('gives a short contestation period a quarter of it, and caps the rest at five minutes', () => {
		expect(gap.observationGraceMs(300n)).toBe(75_000);
		expect(gap.observationGraceMs(DAY_SECONDS)).toBe(GRACE_MS);
	});
});

describe('decideObservationGap', () => {
	it.each([
		['observed, no gap', none, true, 'unchanged'],
		['observed again after a gap', since(10), true, 'clear'],
		['first tick without the node', none, false, 'record'],
		['still inside the grace period', since(4), false, 'touch'],
		['past the grace period', since(5), false, 'alert'],
		[
			'already alerted for this gap',
			{
				observationGapSince: minutesAgo(30),
				observationGapAlertedAt: minutesAgo(25),
				observationCheckedAt: minutesAgo(1),
			},
			false,
			'touch',
		],
		[
			'a gap left from an earlier outage',
			{
				observationGapSince: minutesAgo(90),
				observationGapAlertedAt: minutesAgo(85),
				observationCheckedAt: minutesAgo(60),
			},
			false,
			'record',
		],
	] as const)('%s', (_name, stored, isObserved, expected) => {
		expect(gap.decideObservationGap(stored, isObserved, NOW, GRACE_MS)).toBe(expected);
	});
});

describe('applyObservationGap', () => {
	it('records the error with its cause and the webhook once the gap outlives the grace period', async () => {
		row = since(6);
		await expect(gap.applyObservationGap(head(row), DOWN, NOW)).resolves.toBe('alert');
		expect(row.observationGapAlertedAt).toEqual(NOW);
		expect(mockErrorCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				hydraHeadId: 'head-1',
				errorType: HydraErrorType.HeadUnobserved,
				errorMessage: expect.stringContaining(DOWN),
			}),
		});
		expect(mockQueue).toHaveBeenCalledWith(expect.anything(), {
			hydraHeadId: 'head-1',
			headStatus: HydraHeadStatus.Closed,
			contestationDeadline: '2026-10-28T12:00:00.000Z',
			unobservedSince: minutesAgo(6).toISOString(),
			checkedAt: NOW.toISOString(),
		});
	});

	it('alerts again on the next tick when the webhook could not be queued', async () => {
		row = since(6);
		mockQueue.mockRejectedValueOnce(new Error('queue unavailable') as never);
		await expect(gap.applyObservationGap(head(row), DOWN, NOW)).rejects.toThrow('queue unavailable');
		expect(row.observationGapAlertedAt).toBeNull();
		await expect(gap.applyObservationGap(head(row), DOWN, NOW)).resolves.toBe('alert');
		expect(mockQueue).toHaveBeenCalledTimes(2);
	});

	it('alerts once when two instances see the same gap', async () => {
		row = since(6);
		const staleRead = head(row);
		await gap.applyObservationGap(staleRead, DOWN, NOW);
		await expect(gap.applyObservationGap(staleRead, DOWN, NOW)).resolves.toBe('unchanged');
		expect(mockQueue).toHaveBeenCalledTimes(1);
		expect(mockErrorCreate).toHaveBeenCalledTimes(1);
	});

	it('does not clear a newer gap from a stale read', async () => {
		const staleRead = head(since(10));
		row = since(2);
		await gap.applyObservationGap(staleRead, null, NOW);
		expect(row).toEqual(since(2));
	});

	it('starts a new gap after the node came back, and alerts that one too', async () => {
		row = {
			observationGapSince: minutesAgo(30),
			observationGapAlertedAt: minutesAgo(25),
			observationCheckedAt: minutesAgo(1),
		};
		await gap.applyObservationGap(head(row), null, NOW);
		expect(row).toEqual(none);
		await gap.applyObservationGap(head(row), DOWN, NOW);
		expect(row.observationGapSince).toEqual(NOW);
		await expect(tickEveryMinute(GRACE_MS / 60_000)).resolves.toBe('alert');
		expect(mockQueue).toHaveBeenCalledTimes(1);
	});

	// The service was down, or the head left the watch, while an alerted gap stayed stored.
	it('starts over on a gap left from an earlier outage instead of staying silent', async () => {
		row = {
			observationGapSince: minutesAgo(90),
			observationGapAlertedAt: minutesAgo(85),
			observationCheckedAt: minutesAgo(60),
		};
		await expect(gap.applyObservationGap(head(row), DOWN, NOW)).resolves.toBe('record');
		expect(row).toEqual({ observationGapSince: NOW, observationGapAlertedAt: null, observationCheckedAt: NOW });
		expect(mockQueue).not.toHaveBeenCalled();
		await expect(tickEveryMinute(GRACE_MS / 60_000)).resolves.toBe('alert');
	});

	it('alerts well inside a five-minute contestation period', async () => {
		row = {
			observationGapSince: minutesAgo(1.5),
			observationGapAlertedAt: null,
			observationCheckedAt: minutesAgo(0.5),
		};
		await expect(gap.applyObservationGap(head(row, 300n), DOWN, NOW)).resolves.toBe('alert');
	});
});
