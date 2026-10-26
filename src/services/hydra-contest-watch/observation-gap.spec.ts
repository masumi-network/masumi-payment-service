import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import { HydraPersistenceRotationError } from '@/lib/hydra/hydra/errors';

type AnyMock = Mock<(...args: any[]) => any>;

const mockUpdateMany = jest.fn() as AnyMock;
const mockErrorCreate = jest.fn() as AnyMock;
const mockQueue = jest.fn() as AnyMock;

type StoredGap = {
	observationGapSince: Date | null;
	observationGapAlertedAt: Date | null;
	observationGapAlertedNodeSide: boolean | null;
	observationCheckedAt: Date | null;
};
const none: StoredGap = {
	observationGapSince: null,
	observationGapAlertedAt: null,
	observationGapAlertedNodeSide: null,
	observationCheckedAt: null,
};
/** The head row as the database holds it; a failed transaction restores it. */
let row: StoredGap = { ...none };

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
/** A gap that began `minutes` ago and was last checked one minute ago. */
const since = (minutes: number): StoredGap => ({
	...none,
	observationGapSince: minutesAgo(minutes),
	observationCheckedAt: minutesAgo(1),
});
const DOWN = { reason: 'the node has no verified live session for this head', isNodeSide: true };
const SERVICE = { reason: "this service's replay of the node history has not finished", isNodeSide: false };
const DAY_SECONDS = 86_400n;
const GRACE_MS = 5 * 60_000;

const comparable = (value: Date | boolean | null | undefined) =>
	value instanceof Date ? value.getTime() : (value ?? null);

/** A conditional updateMany against `row`, the way Postgres applies it. */
function applyConditionalUpdate({ where, data }: { where: Partial<StoredGap>; data: Partial<StoredGap> }) {
	const matches = (Object.keys(where) as (keyof StoredGap | 'id')[])
		.filter((key): key is keyof StoredGap => key !== 'id')
		.every((key) => comparable(row[key]) === comparable(where[key]));
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
	overrides: Partial<{
		status: HydraHeadStatus;
		hasVerifiedLiveSession: boolean;
		isAwaitingReplayVerdict: boolean;
		hasVerifiedPinnedSessions: boolean;
		confirmedTransactionHistoryError: Error;
		synced?: boolean;
	}>,
) => {
	const { synced = true, ...rest } = overrides;
	return {
		status: HydraHeadStatus.Open,
		hasVerifiedLiveSession: true,
		isAwaitingReplayVerdict: false,
		hasVerifiedPinnedSessions: true,
		confirmedTransactionHistoryError: undefined,
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

describe('nodeUnobservedCause', () => {
	it('counts a node that follows the head and the chain as observed', () => {
		expect(gap.nodeUnobservedCause(node({}))).toBeNull();
		expect(gap.nodeUnobservedCause(node({ status: HydraHeadStatus.Final }))).toBeNull();
		expect(gap.nodeUnobservedCause({ ...node({}), isChainSynced: () => undefined })).toBeNull();
	});

	// A lost socket leaves the last status in place, so Open alone proves nothing.
	it('does not count a node whose live session is gone, whatever status it last reported', () => {
		expect(gap.nodeUnobservedCause(node({ hasVerifiedLiveSession: false, hasVerifiedPinnedSessions: false }))).toEqual(
			DOWN,
		);
	});

	it('does not count a node that lost the head or the chain', () => {
		expect(gap.nodeUnobservedCause(node({ status: HydraHeadStatus.Idle }))?.reason).toContain('Idle');
		expect(gap.nodeUnobservedCause(node({ synced: false }))).toEqual({
			reason: 'the node does not follow the chain',
			isNodeSide: true,
		});
	});

	// The replay is this service's check, not the node's health.
	it('blames this service, not the node, for a history replay that failed or still runs', () => {
		const running = gap.nodeUnobservedCause(node({ hasVerifiedPinnedSessions: false }));
		expect(running).toEqual({ reason: expect.stringContaining('has not finished'), isNodeSide: false });
		const failed = gap.nodeUnobservedCause(
			node({ hasVerifiedPinnedSessions: false, confirmedTransactionHistoryError: new Error('log rotated') }),
		);
		expect(failed).toEqual({ reason: expect.stringContaining('failed (log rotated)'), isNodeSide: false });
	});

	// A rotated event log drops the live session too, but the node is fine.
	it('blames this service, not the node, for an event log it cannot replay', () => {
		const rotated = node({
			hasVerifiedLiveSession: false,
			hasVerifiedPinnedSessions: false,
			confirmedTransactionHistoryError: new HydraPersistenceRotationError('event log rotated'),
		});
		expect(gap.nodeUnobservedCause(rotated)).toEqual({
			reason: expect.stringContaining('cannot replay the node history (event log rotated)'),
			isNodeSide: false,
		});
	});

	// After a fanout the node greets with no head, and the session is held for the replay.
	it('blames this service, not the node, while a headless Idle waits for the replay', () => {
		const held = node({
			hasVerifiedLiveSession: false,
			isAwaitingReplayVerdict: true,
			hasVerifiedPinnedSessions: false,
		});
		expect(gap.nodeUnobservedCause(held)).toEqual({
			reason: expect.stringContaining('not decided'),
			isNodeSide: false,
		});
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
		['observed, no gap', none, null, 'unchanged'],
		['observed again after a gap', since(10), null, 'clear'],
		['first tick without the node', none, DOWN, 'record'],
		['still inside the grace period', since(4), DOWN, 'touch'],
		['past the grace period', since(5), DOWN, 'alert'],
		[
			'already alerted for this gap',
			{
				observationGapSince: minutesAgo(30),
				observationGapAlertedAt: minutesAgo(25),
				observationGapAlertedNodeSide: true,
				observationCheckedAt: minutesAgo(1),
			},
			DOWN,
			'touch',
		],
		[
			"alerted as this service's fault, and now the node is down",
			{ ...since(30), observationGapAlertedAt: minutesAgo(25), observationGapAlertedNodeSide: false },
			DOWN,
			'escalate',
		],
		[
			"alerted as this service's fault, and still is",
			{ ...since(30), observationGapAlertedAt: minutesAgo(25), observationGapAlertedNodeSide: false },
			SERVICE,
			'touch',
		],
		[
			'a gap left from an earlier outage',
			{
				observationGapSince: minutesAgo(90),
				observationGapAlertedAt: minutesAgo(85),
				observationGapAlertedNodeSide: true,
				observationCheckedAt: minutesAgo(60),
			},
			DOWN,
			'record',
		],
	] as const)('%s', (_name, stored, cause, expected) => {
		expect(gap.decideObservationGap(stored, cause, NOW, GRACE_MS)).toBe(expected);
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
				errorMessage: expect.stringMatching(new RegExp(`${DOWN.reason}.*Restore the node`)),
			}),
		});
		expect(mockQueue).toHaveBeenCalledWith(expect.anything(), {
			hydraHeadId: 'head-1',
			headStatus: HydraHeadStatus.Closed,
			contestationDeadline: '2026-10-28T12:00:00.000Z',
			unobservedSince: minutesAgo(6).toISOString(),
			reason: DOWN.reason,
			isNodeSide: true,
			checkedAt: NOW.toISOString(),
		});
	});

	it('does not tell the operator to restore a node that this service cannot check', async () => {
		row = since(6);
		await expect(gap.applyObservationGap(head(row), SERVICE, NOW)).resolves.toBe('alert');
		const { errorMessage } = (mockErrorCreate.mock.calls[0][0] as { data: { errorMessage: string } }).data;
		expect(errorMessage).toContain('cannot tell whether the node still runs');
		expect(errorMessage).not.toContain('Restore the node');
	});

	// A service-side alert cannot say whether the node runs. If the node then
	// goes down, the deadline may pass in silence.
	it("alerts once more when a gap alerted as this service's fault becomes a node outage", async () => {
		row = since(6);
		await expect(gap.applyObservationGap(head(row), SERVICE, NOW)).resolves.toBe('alert');
		const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
		await expect(gap.applyObservationGap(head(row), SERVICE, later(1))).resolves.toBe('touch');
		await expect(gap.applyObservationGap(head(row), DOWN, later(2))).resolves.toBe('escalate');
		const staleRead = head({ ...row, observationGapAlertedNodeSide: false });
		await expect(gap.applyObservationGap(staleRead, DOWN, later(2))).resolves.toBe('unchanged');
		await expect(gap.applyObservationGap(head(row), DOWN, later(3))).resolves.toBe('touch');

		expect(mockQueue).toHaveBeenCalledTimes(2);
		expect(mockQueue).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ isNodeSide: true }));
		expect(mockErrorCreate).toHaveBeenCalledTimes(2);
		expect(row.observationGapSince).toEqual(minutesAgo(6));
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
			observationGapAlertedNodeSide: true,
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
			observationGapAlertedNodeSide: true,
			observationCheckedAt: minutesAgo(60),
		};
		await expect(gap.applyObservationGap(head(row), DOWN, NOW)).resolves.toBe('record');
		expect(row).toEqual({ ...none, observationGapSince: NOW, observationCheckedAt: NOW });
		expect(mockQueue).not.toHaveBeenCalled();
		await expect(tickEveryMinute(GRACE_MS / 60_000)).resolves.toBe('alert');
	});

	it('alerts well inside a five-minute contestation period', async () => {
		row = { ...none, observationGapSince: minutesAgo(1.5), observationCheckedAt: minutesAgo(0.5) };
		await expect(gap.applyObservationGap(head(row, 300n), DOWN, NOW)).resolves.toBe('alert');
	});
});
