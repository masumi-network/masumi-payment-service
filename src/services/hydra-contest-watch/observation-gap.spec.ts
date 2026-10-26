import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockUpdateMany = jest.fn() as AnyMock;
const mockErrorCreate = jest.fn() as AnyMock;
const mockQueue = jest.fn() as AnyMock;

type StoredGap = { observationGapSince: Date | null; observationGapAlertedAt: Date | null };
/** The head row as the database holds it; a failed transaction restores it. */
let row: StoredGap = { observationGapSince: null, observationGapAlertedAt: null };

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
const none = { observationGapSince: null, observationGapAlertedAt: null };
const since = (minutes: number) => ({ observationGapSince: minutesAgo(minutes), observationGapAlertedAt: null });

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

const head = (stored: StoredGap) => ({
	id: 'head-1',
	status: HydraHeadStatus.Closed,
	contestationDeadline: new Date('2026-10-28T12:00:00.000Z'),
	...stored,
});

describe('isHeadObserved', () => {
	it('counts only node states in which the node follows the head', () => {
		expect(gap.isHeadObserved(HydraHeadStatus.Open)).toBe(true);
		expect(gap.isHeadObserved(HydraHeadStatus.Closed)).toBe(true);
		expect(gap.isHeadObserved(HydraHeadStatus.Final)).toBe(true);
		expect(gap.isHeadObserved(HydraHeadStatus.Disconnected)).toBe(false);
		// A node that lost its state comes back headless and Idle.
		expect(gap.isHeadObserved(HydraHeadStatus.Idle)).toBe(false);
		expect(gap.isHeadObserved(undefined)).toBe(false);
	});
});

describe('decideObservationGap', () => {
	it.each([
		['observed, no gap', none, true, 'unchanged'],
		['observed again after a gap', since(10), true, 'clear'],
		['first tick without the node', none, false, 'record'],
		['still inside the grace period', since(4), false, 'unchanged'],
		['past the grace period', since(5), false, 'alert'],
		[
			'already alerted for this gap',
			{ observationGapSince: minutesAgo(30), observationGapAlertedAt: minutesAgo(25) },
			false,
			'unchanged',
		],
	] as const)('%s', (_name, stored, isObserved, expected) => {
		expect(gap.decideObservationGap(stored, isObserved, NOW)).toBe(expected);
	});
});

describe('applyObservationGap', () => {
	it('records the error and the webhook once the gap outlives the grace period', async () => {
		row = since(6);
		await expect(gap.applyObservationGap(head(row), false, NOW)).resolves.toBe('alert');
		expect(row.observationGapAlertedAt).toEqual(NOW);
		expect(mockErrorCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({ hydraHeadId: 'head-1', errorType: HydraErrorType.HeadUnobserved }),
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
		await expect(gap.applyObservationGap(head(row), false, NOW)).rejects.toThrow('queue unavailable');
		expect(row.observationGapAlertedAt).toBeNull();
		await expect(gap.applyObservationGap(head(row), false, NOW)).resolves.toBe('alert');
		expect(mockQueue).toHaveBeenCalledTimes(2);
	});

	it('alerts once when two instances see the same gap', async () => {
		row = since(6);
		const staleRead = head(row);
		await gap.applyObservationGap(staleRead, false, NOW);
		await expect(gap.applyObservationGap(staleRead, false, NOW)).resolves.toBe('unchanged');
		expect(mockQueue).toHaveBeenCalledTimes(1);
		expect(mockErrorCreate).toHaveBeenCalledTimes(1);
	});

	it('starts a new gap after the node came back, and alerts that one too', async () => {
		row = { observationGapSince: minutesAgo(30), observationGapAlertedAt: minutesAgo(25) };
		await gap.applyObservationGap(head(row), true, NOW);
		expect(row).toEqual(none);
		await gap.applyObservationGap(head(row), false, NOW);
		expect(row.observationGapSince).toEqual(NOW);
		const later = new Date(NOW.getTime() + gap.OBSERVATION_GRACE_MS);
		await expect(gap.applyObservationGap(head(row), false, later)).resolves.toBe('alert');
		expect(mockQueue).toHaveBeenCalledTimes(1);
	});
});
