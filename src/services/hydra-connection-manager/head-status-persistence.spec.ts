import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import type { CustomHydraHead } from '@/lib/hydra';
import type { HeadStatusPersistenceHost } from './head-status-persistence';

const mockFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockUpdateMany = jest.fn<(_args: unknown) => Promise<{ count: number }>>();
const mockPersistRegressive = jest.fn<(...args: unknown[]) => Promise<string>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindUnique, updateMany: mockUpdateMany } },
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

const { persistHeadStatus, failClosedAfterStatusPersistenceFailure, recordCloseTransaction } =
	await import('./head-status-persistence');

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
});

describe('failClosedAfterStatusPersistenceFailure under the ownership fence', () => {
	it('fences the durable disable on the owner epoch', async () => {
		const persistenceHost = host();
		await failClosedAfterStatusPersistenceFailure(persistenceHost, 'head-1', fakeHead(), 3n);

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1', ownerEpoch: 3n },
			data: { isEnabled: false, initTxHash: null, initChainSlot: null, initChainHash: null, reconciliationCompletedAt: null },
		});
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
