import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockTrigger = jest.fn() as AnyMock;
const mockRecordHeadError = jest.fn() as AnyMock;
const mockGetNode = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findMany: mockFindMany, updateMany: mockUpdateMany } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: { triggerHydraHeadContestMissing: mockTrigger },
}));
jest.unstable_mockModule('@/services/hydra-head-error/record', () => ({
	recordHeadError: mockRecordHeadError,
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode }),
}));

let watch: typeof import('./watch');

beforeAll(async () => {
	watch = await import('./watch');
});

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 } as never);
});

const NOW = new Date('2026-10-22T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const empty = { contestGapSignature: null, contestGapSince: null, contestGapAlertedAt: null };
const closedOnThree = {
	status: HydraHeadStatus.Closed,
	closedSnapshotNumber: 3n,
	verifiedSnapshotNumber: 5n,
};
const recorded = (minutes: number) => ({ ...empty, contestGapSignature: '3<5', contestGapSince: minutesAgo(minutes) });

describe('decideContestGap', () => {
	it('starts the clock when the chain holds an older snapshot than ours', () => {
		expect(watch.decideContestGap(empty, closedOnThree, NOW)).toEqual({
			action: 'record',
			signature: '3<5',
			isAlerting: false,
		});
	});

	it('waits while a contest can still land', () => {
		expect(watch.decideContestGap(recorded(1), closedOnThree, NOW)).toEqual({ action: 'unchanged' });
	});

	it('alerts once the grace period passes without a contest', () => {
		expect(watch.decideContestGap(recorded(2), closedOnThree, NOW)).toEqual({ action: 'alert' });
	});

	it('alerts at once when fanout is already possible', () => {
		const pastDeadline = { ...closedOnThree, status: HydraHeadStatus.FanoutPossible };
		expect(watch.decideContestGap(recorded(0), pastDeadline, NOW)).toEqual({ action: 'alert' });
		// A service that comes back after the deadline must not wait a round to say so.
		expect(watch.decideContestGap(empty, pastDeadline, NOW)).toEqual({
			action: 'record',
			signature: '3<5',
			isAlerting: true,
		});
	});

	it('never alerts twice for one gap', () => {
		const alerted = { ...recorded(30), contestGapAlertedAt: minutesAgo(20) };
		expect(watch.decideContestGap(alerted, closedOnThree, NOW)).toEqual({ action: 'unchanged' });
	});

	// A peer contested with a snapshot between the two: our node must contest
	// again, and gets a fresh grace period to do it.
	it('restarts the clock when a contest moved the chain but not far enough', () => {
		const alerted = { ...recorded(30), contestGapAlertedAt: minutesAgo(20) };
		const contestedOnFour = { ...closedOnThree, closedSnapshotNumber: 4n };
		expect(watch.decideContestGap(alerted, contestedOnFour, NOW)).toEqual({
			action: 'record',
			signature: '4<5',
			isAlerting: false,
		});
	});

	it('clears the gap once a contest put our snapshot on chain', () => {
		const contested = { ...closedOnThree, closedSnapshotNumber: 5n };
		expect(watch.decideContestGap(recorded(30), contested, NOW)).toEqual({ action: 'clear' });
		expect(watch.decideContestGap(empty, contested, NOW)).toEqual({ action: 'unchanged' });
	});
});

describe('applyContestGapObservation', () => {
	it('records the error and fires the webhook once it claims the alert', async () => {
		await expect(watch.applyContestGapObservation({ id: 'head-1', ...recorded(5) }, closedOnThree, NOW)).resolves.toBe(
			'alert',
		);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1', contestGapSignature: '3<5', contestGapAlertedAt: null },
			data: { contestGapAlertedAt: NOW },
		});
		expect(mockRecordHeadError).toHaveBeenCalledWith(
			'head-1',
			HydraHeadStatus.Closed,
			HydraErrorType.ContestMissing,
			expect.stringContaining('snapshot 3'),
			'ContestWatch',
		);
		expect(mockTrigger).toHaveBeenCalledWith(
			expect.objectContaining({ hydraHeadId: 'head-1', closedSnapshotNumber: 3, verifiedSnapshotNumber: 5 }),
		);
	});

	it('alerts in the same write that records a gap first seen past the deadline', async () => {
		const pastDeadline = { ...closedOnThree, status: HydraHeadStatus.FanoutPossible };
		await watch.applyContestGapObservation({ id: 'head-1', ...empty }, pastDeadline, NOW);
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		// Marked alerted in that write, so the next run does not alert again.
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1', contestGapSignature: null },
			data: expect.objectContaining({ contestGapAlertedAt: NOW }),
		});
		expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({ gapSince: NOW.toISOString() }));
	});

	it('stays quiet when another instance recorded the gap first', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 } as never);
		const pastDeadline = { ...closedOnThree, status: HydraHeadStatus.FanoutPossible };
		await watch.applyContestGapObservation({ id: 'head-1', ...empty }, pastDeadline, NOW);
		expect(mockTrigger).not.toHaveBeenCalled();
	});

	it('stays quiet when another instance claimed the alert first', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 } as never);
		await expect(watch.applyContestGapObservation({ id: 'head-1', ...recorded(5) }, closedOnThree, NOW)).resolves.toBe(
			'unchanged',
		);
		expect(mockRecordHeadError).not.toHaveBeenCalled();
		expect(mockTrigger).not.toHaveBeenCalled();
	});
});

describe('runHydraContestWatch', () => {
	// A node still replaying knows neither number. Treating that as "no gap"
	// would clear a gap that is still there and re-alert it later.
	it('leaves a recorded gap alone while the node cannot say', async () => {
		mockFindMany.mockResolvedValue([{ id: 'head-1', status: HydraHeadStatus.Closed, ...recorded(30) }] as never);
		mockGetNode.mockReturnValue({ closedSnapshotNumber: undefined, verifiedSnapshotNumber: 5n });
		await watch.runHydraContestWatch();
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('compares the chain with the node for a head this instance holds', async () => {
		mockFindMany.mockResolvedValue([{ id: 'head-1', status: HydraHeadStatus.Closed, ...empty }] as never);
		mockGetNode.mockReturnValue({ closedSnapshotNumber: 3n, verifiedSnapshotNumber: 5n });
		await watch.runHydraContestWatch();
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1', contestGapSignature: null },
			data: expect.objectContaining({ contestGapSignature: '3<5', contestGapAlertedAt: null }),
		});
	});
});
