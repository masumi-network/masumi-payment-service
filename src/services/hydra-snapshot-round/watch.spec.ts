import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { HydraSnapshotRound } from '@/lib/hydra/hydra/node-control-queries';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockTrigger = jest.fn() as AnyMock;
const mockGetNode = jest.fn() as AnyMock;
const mockFetchRound = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findMany: mockFindMany, updateMany: mockUpdateMany } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: { triggerHydraHeadSnapshotRoundStuck: mockTrigger },
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode }),
}));
jest.unstable_mockModule('@/lib/hydra/hydra/node-control-queries', () => ({
	fetchHydraSnapshotRound: mockFetchRound,
}));

let watch: typeof import('./watch');

beforeAll(async () => {
	watch = await import('./watch');
});

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 } as never);
});

const NOW = new Date('2026-10-16T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

function round(overrides: Partial<HydraSnapshotRound> = {}): HydraSnapshotRound {
	return {
		inFlight: true,
		tag: 'SeenSnapshot',
		number: 314,
		signatoryCount: 1,
		txIds: ['dc3e'],
		signature: 'SeenSnapshot|314|1',
		...overrides,
	};
}

const idle = round({ inFlight: false, tag: 'LastSeenSnapshot', number: null, signature: 'LastSeenSnapshot|-|0' });
const empty = { snapshotRoundSignature: null, snapshotRoundSince: null, snapshotRoundAlertedAt: null };

describe('decideSnapshotRound', () => {
	it('starts the clock on a round it has not seen', () => {
		expect(watch.decideSnapshotRound(empty, round(), NOW)).toEqual({ action: 'record' });
	});

	it('restarts the clock when the round moved', () => {
		const stored = { ...empty, snapshotRoundSignature: 'SeenSnapshot|313|2', snapshotRoundSince: minutesAgo(30) };
		expect(watch.decideSnapshotRound(stored, round(), NOW)).toEqual({ action: 'record' });
	});

	it('waits below the threshold', () => {
		const stored = { ...empty, snapshotRoundSignature: round().signature, snapshotRoundSince: minutesAgo(9) };
		expect(watch.decideSnapshotRound(stored, round(), NOW)).toEqual({ action: 'unchanged' });
	});

	it('alerts once the same round passes the threshold', () => {
		const stored = { ...empty, snapshotRoundSignature: round().signature, snapshotRoundSince: minutesAgo(10) };
		expect(watch.decideSnapshotRound(stored, round(), NOW)).toEqual({ action: 'alert' });
	});

	it('never alerts twice for one round', () => {
		const stored = {
			snapshotRoundSignature: round().signature,
			snapshotRoundSince: minutesAgo(60),
			snapshotRoundAlertedAt: minutesAgo(50),
		};
		expect(watch.decideSnapshotRound(stored, round(), NOW)).toEqual({ action: 'unchanged' });
	});

	it('clears a recorded round once the node is idle, and leaves an empty row alone', () => {
		const stored = { ...empty, snapshotRoundSignature: round().signature, snapshotRoundSince: minutesAgo(60) };
		expect(watch.decideSnapshotRound(stored, idle, NOW)).toEqual({ action: 'clear' });
		expect(watch.decideSnapshotRound(empty, idle, NOW)).toEqual({ action: 'unchanged' });
	});
});

describe('applySnapshotRoundObservation', () => {
	it('conditions every write on the signature it read', async () => {
		const head = {
			id: 'head-1',
			...empty,
			snapshotRoundSignature: 'SeenSnapshot|313|2',
			snapshotRoundSince: minutesAgo(1),
		};
		await watch.applySnapshotRoundObservation(head, round(), NOW);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1', snapshotRoundSignature: 'SeenSnapshot|313|2' },
			data: { snapshotRoundSignature: 'SeenSnapshot|314|1', snapshotRoundSince: NOW, snapshotRoundAlertedAt: null },
		});
	});

	it('sends the webhook only when it wins the alert claim', async () => {
		const head = {
			id: 'head-1',
			...empty,
			snapshotRoundSignature: round().signature,
			snapshotRoundSince: minutesAgo(15),
		};

		await expect(watch.applySnapshotRoundObservation(head, round(), NOW)).resolves.toBe('alert');
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1', snapshotRoundSignature: round().signature, snapshotRoundAlertedAt: null },
			data: { snapshotRoundAlertedAt: NOW },
		});
		expect(mockTrigger).toHaveBeenCalledWith({
			hydraHeadId: 'head-1',
			roundTag: 'SeenSnapshot',
			snapshotNumber: 314,
			signatoryCount: 1,
			txIds: ['dc3e'],
			stuckSince: minutesAgo(15).toISOString(),
			checkedAt: NOW.toISOString(),
		});

		mockTrigger.mockClear();
		mockUpdateMany.mockResolvedValueOnce({ count: 0 } as never);
		await expect(watch.applySnapshotRoundObservation(head, round(), NOW)).resolves.toBe('unchanged');
		expect(mockTrigger).not.toHaveBeenCalled();
	});
});

describe('runHydraSnapshotRoundWatch', () => {
	it('reads only heads this instance holds a session for, and keeps going past a failing one', async () => {
		mockFindMany.mockResolvedValue([
			{ id: 'not-ours', ...empty },
			{ id: 'broken', ...empty },
			{ id: 'ours', ...empty },
		] as never);
		const node = { name: 'node' };
		mockGetNode.mockImplementation(((id: string) => (id === 'not-ours' ? null : node)) as never);
		mockFetchRound.mockRejectedValueOnce(new Error('boom') as never).mockResolvedValueOnce(round() as never);

		await watch.runHydraSnapshotRoundWatch();

		expect(mockFetchRound).toHaveBeenCalledTimes(2);
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'ours' } });
	});
});
