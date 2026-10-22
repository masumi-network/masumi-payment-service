import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import type { CustomHydraHead } from '@/lib/hydra';
import type { HeadStatusPersistenceHost } from './head-status-persistence';

const mockFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockFindMany = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockUpdateMany = jest.fn<(_args: unknown) => Promise<{ count: number }>>();
const mockPersistRegressive = jest.fn<(...args: unknown[]) => Promise<string>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindUnique, findMany: mockFindMany, updateMany: mockUpdateMany } },
}));

jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async (operation: () => Promise<unknown>) => await operation(),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('./head-session-ops', () => ({
	persistRegressiveHeadStatus: mockPersistRegressive,
}));

const mockMarkHeadFailedClosed = jest.fn();
const mockForgetHeadFailedClosed = jest.fn();
jest.unstable_mockModule('./head-auto-disable-recovery', () => ({
	markHeadFailedClosed: mockMarkHeadFailedClosed,
	forgetHeadFailedClosed: mockForgetHeadFailedClosed,
}));

const { persistHeadStatus, failClosedAfterStatusPersistenceFailure, recordCloseTransaction, recordClosedHeadFacts } =
	await import('./head-status-persistence');
const { logger } = await import('@masumi/payment-core/logger');

function host(): { [K in keyof HeadStatusPersistenceHost]: jest.Mock } {
	return {
		quarantine: jest.fn(),
		clearQuarantineAfterReobservation: jest.fn(),
		scheduleRecovery: jest.fn(),
		onStaleOwner: jest.fn(),
	};
}

function fakeHead(): CustomHydraHead {
	return {
		mainNode: { pinExpectedHeadId: jest.fn(), fetchHeadOutputTxId: jest.fn(), fetchClosedHeadFacts: jest.fn() },
	} as unknown as CustomHydraHead;
}

/** A durable head row at Open, owned by epoch 1 unless a test says otherwise. */
function durableRow(overrides: Record<string, unknown> = {}) {
	return {
		isEnabled: true,
		status: HydraHeadStatus.Open,
		hydraRelationId: 'relation-1',
		headIdentifier: 'a'.repeat(56),
		openedAt: new Date('2026-08-01T10:00:00Z'),
		closedAt: null,
		finalizedAt: null,
		contestationDeadline: null,
		latestSnapshotNumber: 0n,
		ownerEpoch: 1n,
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFindUnique.mockResolvedValue(durableRow());
	mockUpdateMany.mockResolvedValue({ count: 1 });
});

/**
 * The fencing seam (ADR-0014): every durable lifecycle write carries the
 * epoch the transport was acquired under, and a session whose epoch the
 * database has moved past must self-demote — never write, never disable.
 */
describe('persistHeadStatus under the ownership fence', () => {
	it('carries the owner epoch on the status compare-and-set', async () => {
		const persistenceHost = host();
		await persistHeadStatus(persistenceHost, 'head-1', fakeHead(), 1n, { status: HydraHeadStatus.Closed });

		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		const call = mockUpdateMany.mock.calls[0][0] as { where: Record<string, unknown> };
		expect(call.where.ownerEpoch).toBe(1n);
		expect(persistenceHost.onStaleOwner).not.toHaveBeenCalled();
	});

	it('self-demotes without any durable write when the durable epoch has moved', async () => {
		mockFindUnique.mockResolvedValue(durableRow({ ownerEpoch: 2n }));
		const persistenceHost = host();

		await persistHeadStatus(persistenceHost, 'head-1', fakeHead(), 1n, { status: HydraHeadStatus.Closed });

		expect(persistenceHost.onStaleOwner).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).not.toHaveBeenCalled();
		// Critically: a superseded session is not a persistence FAILURE. It must
		// not quarantine the slot or durably disable the head a newer owner runs.
		expect(persistenceHost.quarantine).not.toHaveBeenCalled();
		expect(persistenceHost.scheduleRecovery).not.toHaveBeenCalled();
	});

	// The relation is held for explicit operator recovery; an earlier
	// fail-closed mark must not re-enable any of its heads automatically.
	it('drops the auto-recovery mark of every head a rollback quarantined', async () => {
		mockFindUnique.mockResolvedValue(durableRow({ status: HydraHeadStatus.Final }));
		mockPersistRegressive.mockResolvedValue('quarantined-relation-conflict');
		mockFindMany.mockResolvedValue([{ id: 'head-1' }, { id: 'head-2' }]);

		await persistHeadStatus(host(), 'head-1', fakeHead(), 1n, { status: HydraHeadStatus.Open });

		expect(mockForgetHeadFailedClosed).toHaveBeenCalledWith('head-1');
		expect(mockForgetHeadFailedClosed).toHaveBeenCalledWith('head-2');
	});

	it('drops the auto-recovery mark when a rollback below Open disabled the head', async () => {
		mockFindUnique.mockResolvedValue(durableRow({ status: HydraHeadStatus.Open }));
		mockPersistRegressive.mockResolvedValue('persisted');
		mockFindMany.mockResolvedValue([{ id: 'head-1' }]);

		await persistHeadStatus(host(), 'head-1', fakeHead(), 1n, { status: HydraHeadStatus.Initializing });

		expect(mockForgetHeadFailedClosed).toHaveBeenCalledWith('head-1');
	});

	it('keeps the mark for a rollback that leaves the head open', async () => {
		mockFindUnique.mockResolvedValue(durableRow({ status: HydraHeadStatus.Closed }));
		mockPersistRegressive.mockResolvedValue('persisted');

		await persistHeadStatus(host(), 'head-1', fakeHead(), 1n, { status: HydraHeadStatus.Open });

		expect(mockForgetHeadFailedClosed).not.toHaveBeenCalled();
	});

	it('treats a stale-owner rollback verdict as self-demotion, not failure', async () => {
		mockFindUnique.mockResolvedValue(durableRow({ status: HydraHeadStatus.Final }));
		mockPersistRegressive.mockResolvedValue('stale-owner');
		const persistenceHost = host();

		await persistHeadStatus(persistenceHost, 'head-1', fakeHead(), 1n, { status: HydraHeadStatus.Open });

		expect(mockPersistRegressive).toHaveBeenCalledWith(
			'head-1',
			'relation-1',
			HydraHeadStatus.Open,
			undefined,
			undefined,
			1n,
		);
		expect(persistenceHost.onStaleOwner).toHaveBeenCalledTimes(1);
		expect(persistenceHost.quarantine).not.toHaveBeenCalled();
	});

	it('still fails closed on a genuine persistence failure', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });
		const persistenceHost = host();

		await persistHeadStatus(persistenceHost, 'head-1', fakeHead(), 1n, { status: HydraHeadStatus.Closed });

		expect(persistenceHost.quarantine).toHaveBeenCalledTimes(1);
		expect(persistenceHost.scheduleRecovery).toHaveBeenCalledTimes(1);
	});

	// This miss disables the head. Without the row it was compared against, the
	// log cannot say what moved, and the cause of the disable is lost.
	it('logs the durable row next to the frame when the compare-and-set keeps missing', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });

		await persistHeadStatus(host(), 'head-1', fakeHead(), 1n, { status: HydraHeadStatus.Closed });

		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Head status changed concurrently'),
			expect.objectContaining({
				status: HydraHeadStatus.Closed,
				sessionOwnerEpoch: '1',
				durableIsEnabled: true,
				durableStatus: HydraHeadStatus.Open,
				durableOwnerEpoch: '1',
			}),
		);
	});
});

describe('failClosedAfterStatusPersistenceFailure under the ownership fence', () => {
	it('fences the durable disable on the owner epoch', async () => {
		const persistenceHost = host();
		await failClosedAfterStatusPersistenceFailure(persistenceHost, 'head-1', fakeHead(), 3n);

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1', ownerEpoch: 3n, retiredAt: null, isEnabled: true },
			data: {
				isEnabled: false,
				initTxHash: null,
				initChainSlot: null,
				initChainHash: null,
				reconciliationCompletedAt: null,
			},
		});
	});

	it('marks the head for automatic recovery only when this write disabled it', async () => {
		mockUpdateMany.mockResolvedValue({ count: 1 });
		await failClosedAfterStatusPersistenceFailure(host(), 'head-1', fakeHead(), 1n);
		expect(mockMarkHeadFailedClosed).toHaveBeenCalledWith('head-1');

		mockMarkHeadFailedClosed.mockClear();
		mockUpdateMany.mockClear();
		// Already disabled (an operator or a rollback quarantine did it): not ours
		// to undo. Init evidence is still cleared.
		mockUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
		await failClosedAfterStatusPersistenceFailure(host(), 'head-1', fakeHead(), 1n);
		expect(mockMarkHeadFailedClosed).not.toHaveBeenCalled();
		expect(mockUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({ where: { id: 'head-1', ownerEpoch: 1n, retiredAt: null } }),
		);

		// Fenced out by a newer owner: not ours either.
		mockUpdateMany.mockResolvedValue({ count: 0 });
		await failClosedAfterStatusPersistenceFailure(host(), 'head-1', fakeHead(), 1n);
		expect(mockMarkHeadFailedClosed).not.toHaveBeenCalled();
	});

	it('still schedules recovery when the disable was fenced out', async () => {
		// The local teardown must happen either way; only the durable disable is
		// the newer owner's to make.
		mockUpdateMany.mockResolvedValue({ count: 0 });
		const persistenceHost = host();

		await failClosedAfterStatusPersistenceFailure(persistenceHost, 'head-1', fakeHead(), 1n);

		expect(persistenceHost.quarantine).toHaveBeenCalledTimes(1);
		expect(persistenceHost.scheduleRecovery).toHaveBeenCalledTimes(1);
	});
});

describe('recordCloseTransaction under the ownership fence', () => {
	it('guards the close-hash write on null-ness and the owner epoch', async () => {
		const head = fakeHead();
		(head.mainNode.fetchHeadOutputTxId as jest.Mock).mockReturnValue(Promise.resolve('c'.repeat(64)));

		await recordCloseTransaction('head-1', head.mainNode, 2n);

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1', closeTxHash: null, ownerEpoch: 2n },
			data: { closeTxHash: 'c'.repeat(64) },
		});
	});

	it('swallows a failed head-output read: a close that cannot be named is still a close', async () => {
		const head = fakeHead();
		(head.mainNode.fetchHeadOutputTxId as jest.Mock).mockReturnValue(Promise.reject(new Error('node is gone')));

		await expect(recordCloseTransaction('head-1', head.mainNode, 2n)).resolves.toBeUndefined();
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});
});

/**
 * A head closed while the service was off is first seen through Greetings, which
 * carry no deadline, so the row would have none. The node still knows it.
 */
describe('recordClosedHeadFacts under the ownership fence', () => {
	const FACTS = { contestationDeadline: '2026-10-22T12:00:00Z' };
	const factsOf = (head: CustomHydraHead) => head.mainNode.fetchClosedHeadFacts as unknown as jest.Mock;

	it('writes only the deadline, guarded on null-ness and the owner epoch', async () => {
		const head = fakeHead();
		factsOf(head).mockReturnValue(Promise.resolve(FACTS));

		await recordClosedHeadFacts('head-1', head.mainNode, 2n);

		// The node's own snapshot is not the closed one, so no snapshot is written here.
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1', contestationDeadline: null, ownerEpoch: 2n },
			data: { contestationDeadline: new Date('2026-10-22T12:00:00Z') },
		});
	});

	it('writes nothing for an unparseable deadline', async () => {
		const head = fakeHead();
		factsOf(head).mockReturnValue(Promise.resolve({ contestationDeadline: 'not a date' }));

		await recordClosedHeadFacts('head-1', head.mainNode, 2n);

		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('writes nothing when the node cannot say', async () => {
		const head = fakeHead();
		factsOf(head).mockReturnValue(Promise.resolve(undefined));

		await expect(recordClosedHeadFacts('head-1', head.mainNode, 2n)).resolves.toBeUndefined();
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('swallows a failed read: a closed head whose deadline cannot be read is still closed', async () => {
		const head = fakeHead();
		factsOf(head).mockImplementation(() => Promise.reject(new Error('node is gone')));

		await expect(recordClosedHeadFacts('head-1', head.mainNode, 2n)).resolves.toBeUndefined();
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('swallows a failed write', async () => {
		const head = fakeHead();
		factsOf(head).mockReturnValue(Promise.resolve(FACTS));
		mockUpdateMany.mockRejectedValue(new Error('database is gone'));

		await expect(recordClosedHeadFacts('head-1', head.mainNode, 2n)).resolves.toBeUndefined();
	});
});

describe('persistHeadStatus for a head closed while the service was off', () => {
	const FACTS = { contestationDeadline: '2026-10-22T12:00:00Z' };
	const HEAD_ID = 'a'.repeat(56);
	const factsOf = (head: CustomHydraHead) => head.mainNode.fetchClosedHeadFacts as unknown as jest.Mock;
	const writesOf = (field: string) =>
		mockUpdateMany.mock.calls.filter(([call]) => field in ((call as { data: Record<string, unknown> }).data ?? {}))
			.length;

	it('records the deadline, but not a snapshot, when the Closed status arrives without them', async () => {
		const head = fakeHead();
		factsOf(head).mockReturnValue(Promise.resolve(FACTS));

		await persistHeadStatus(host(), 'head-1', head, 1n, { status: HydraHeadStatus.Closed, headId: HEAD_ID });

		expect(writesOf('contestationDeadline')).toBe(1);
		// The reconciler takes the closed snapshot from the replayed history.
		expect(writesOf('latestSnapshotNumber')).toBe(0);
	});

	// The deadline can have passed while the service was off, so the first thing it sees is ReadyToFanout.
	it('records it for a head first seen at FanoutPossible', async () => {
		const head = fakeHead();
		factsOf(head).mockReturnValue(Promise.resolve(FACTS));

		await persistHeadStatus(host(), 'head-1', head, 1n, { status: HydraHeadStatus.FanoutPossible, headId: HEAD_ID });

		expect(writesOf('contestationDeadline')).toBe(1);
	});

	it('records it for a head first seen fanning out in steps', async () => {
		const head = fakeHead();
		factsOf(head).mockReturnValue(Promise.resolve(FACTS));

		await persistHeadStatus(host(), 'head-1', head, 1n, { status: HydraHeadStatus.FanningOut, headId: HEAD_ID });

		expect(writesOf('contestationDeadline')).toBe(1);
	});

	it('fills in a row that was already stored without it, when the head is seen again', async () => {
		mockFindUnique.mockResolvedValue(durableRow({ status: HydraHeadStatus.Closed, closedAt: new Date() }));
		const head = fakeHead();
		factsOf(head).mockReturnValue(Promise.resolve(FACTS));

		await persistHeadStatus(host(), 'head-1', head, 1n, { status: HydraHeadStatus.Closed, headId: HEAD_ID });

		expect(writesOf('contestationDeadline')).toBe(1);
	});

	it('does not ask the node when the frame carried the deadline', async () => {
		const head = fakeHead();

		await persistHeadStatus(host(), 'head-1', head, 1n, {
			status: HydraHeadStatus.Closed,
			headId: HEAD_ID,
			snapshotNumber: 7,
			contestationDeadline: '2026-10-22T12:00:00Z',
		});

		expect(factsOf(head)).not.toHaveBeenCalled();
	});

	it('does not ask the node when the row already holds a deadline', async () => {
		mockFindUnique.mockResolvedValue(
			durableRow({ status: HydraHeadStatus.Closed, contestationDeadline: new Date('2026-10-22T12:00:00Z') }),
		);
		const head = fakeHead();

		await persistHeadStatus(host(), 'head-1', head, 1n, { status: HydraHeadStatus.FanoutPossible, headId: HEAD_ID });

		expect(factsOf(head)).not.toHaveBeenCalled();
	});

	it.each([
		['an Open head', HydraHeadStatus.Initializing, HydraHeadStatus.Open],
		['a Final head, which the node no longer holds', HydraHeadStatus.FanningOut, HydraHeadStatus.Final],
	])('does not ask the node for %s', async (_label, stored, observed) => {
		mockFindUnique.mockResolvedValue(durableRow({ status: stored }));
		const head = fakeHead();

		await persistHeadStatus(host(), 'head-1', head, 1n, { status: observed, headId: HEAD_ID });

		expect(factsOf(head)).not.toHaveBeenCalled();
	});

	it('keeps the status it stored when the node cannot be read', async () => {
		const head = fakeHead();
		factsOf(head).mockImplementation(() => Promise.reject(new Error('node is gone')));
		const persistenceHost = host();

		await persistHeadStatus(persistenceHost, 'head-1', head, 1n, { status: HydraHeadStatus.Closed, headId: HEAD_ID });

		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(persistenceHost.quarantine).not.toHaveBeenCalled();
	});
});
