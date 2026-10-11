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

const { persistHeadStatus, failClosedAfterStatusPersistenceFailure, recordCloseTransaction } =
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
	return { mainNode: { pinExpectedHeadId: jest.fn(), fetchHeadOutputTxId: jest.fn() } } as unknown as CustomHydraHead;
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
			where: { id: 'head-1', ownerEpoch: 3n, isEnabled: true },
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
			expect.objectContaining({ where: { id: 'head-1', ownerEpoch: 1n } }),
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
