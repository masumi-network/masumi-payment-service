import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockHostFindUnique = jest.fn() as AnyMock;
const mockHostUpdate = jest.fn() as AnyMock;
const mockHostUpdateMany = jest.fn() as AnyMock;
const mockHostFindMany = jest.fn() as AnyMock;
const mockParticipantFindMany = jest.fn() as AnyMock;
const mockParticipantFindUnique = jest.fn() as AnyMock;
const mockQueryRaw = jest.fn() as AnyMock;
const mockTransactionCount = jest.fn() as AnyMock;
const mockTopupCount = jest.fn() as AnyMock;
const mockDecommitCount = jest.fn() as AnyMock;
const mockHeadCount = jest.fn() as AnyMock;
const mockStartHostNode = jest.fn() as AnyMock;
const mockStopHostNode = jest.fn() as AnyMock;
const mockFetchHostNodeHealth = jest.fn() as AnyMock;

const tx = {
	$queryRaw: mockQueryRaw,
	hydraHost: { update: mockHostUpdate },
	hydraLocalParticipant: { findMany: mockParticipantFindMany },
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
		hydraHost: {
			findUnique: mockHostFindUnique,
			updateMany: mockHostUpdateMany,
			findMany: mockHostFindMany,
		},
		hydraLocalParticipant: { findUnique: mockParticipantFindUnique },
		transaction: { count: mockTransactionCount },
		hydraTopup: { count: mockTopupCount },
		hydraDecommit: { count: mockDecommitCount },
		hydraHead: { count: mockHeadCount },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	decrypt: (value: string) => `plain:${value}`,
}));

class FakeHostRequestError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
	}
}

jest.unstable_mockModule('./client', () => ({
	HydraHostRequestError: FakeHostRequestError,
	startHostNode: mockStartHostNode,
	stopHostNode: mockStopHostNode,
	fetchHostNodeHealth: mockFetchHostNodeHealth,
}));

let pause: typeof import('./pause');

beforeAll(async () => {
	pause = await import('./pause');
});

const PAUSED_AT = new Date('2026-10-17T10:00:00.000Z');

function hostRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'host-1',
		baseUrl: 'https://hydra1.example.com',
		allowInsecureHttp: false,
		encryptedAdminToken: 'admin',
		encryptedUserToken: 'user',
		pausedAt: PAUSED_AT,
		pausedNodeIds: ['node-a', 'node-b'],
		pauseStopRequestedAt: null,
		...overrides,
	};
}

function setInFlight(l2: number, topups = 0, withdrawals = 0, closingHeads = 0) {
	mockTransactionCount.mockResolvedValue(l2);
	mockTopupCount.mockResolvedValue(topups);
	mockDecommitCount.mockResolvedValue(withdrawals);
	mockHeadCount.mockResolvedValue(closingHeads);
}

beforeEach(() => {
	jest.clearAllMocks();
	setInFlight(0);
	mockHostUpdateMany.mockResolvedValue({ count: 1 });
	mockStopHostNode.mockResolvedValue(undefined);
	mockStartHostNode.mockResolvedValue(undefined);
	mockFetchHostNodeHealth.mockResolvedValue({ state: 'Stopped' });
});

describe('pauseHydraHost', () => {
	it('records the pause and the nodes it owns, in the locked write', async () => {
		mockQueryRaw.mockResolvedValue([{ pausedAt: null, encryptedAdminToken: 'admin' }]);
		mockParticipantFindMany.mockResolvedValue([{ hostNodeId: 'node-a' }, { hostNodeId: 'node-b' }]);
		mockHostFindUnique.mockResolvedValue(hostRow());
		setInFlight(1);

		const state = await pause.pauseHydraHost('host-1', { force: false });

		expect(mockHostUpdate).toHaveBeenCalledWith({
			where: { id: 'host-1' },
			data: expect.objectContaining({ pausedNodeIds: ['node-a', 'node-b'], pauseStopRequestedAt: null }),
		});
		// In-flight work holds the nodes running.
		expect(mockStopHostNode).not.toHaveBeenCalled();
		expect(state.phase).toBe('Draining');
	});

	it('refuses a host without an admin token, because it could never reach Paused', async () => {
		mockQueryRaw.mockResolvedValue([{ pausedAt: null, encryptedAdminToken: null }]);

		await expect(pause.pauseHydraHost('host-1', { force: false })).rejects.toMatchObject({ status: 409 });
		expect(mockHostUpdate).not.toHaveBeenCalled();
	});

	it('does not reset an existing pause', async () => {
		mockQueryRaw.mockResolvedValue([{ pausedAt: PAUSED_AT, encryptedAdminToken: 'admin' }]);
		mockHostFindUnique.mockResolvedValue(hostRow());

		await pause.pauseHydraHost('host-1', { force: false });

		expect(mockHostUpdate).not.toHaveBeenCalled();
	});
});

describe('advanceHydraHostPause', () => {
	it('stops every paused node once nothing is in flight, then records the request', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockStopHostNode.mock.calls.map((call) => call[2])).toEqual(['node-a', 'node-b']);
		expect(mockHostUpdateMany).toHaveBeenCalledWith({
			where: { id: 'host-1', pausedAt: PAUSED_AT, pauseStopRequestedAt: null },
			data: { pauseStopRequestedAt: expect.any(Date) },
		});
	});

	it('stops at once when forced, even with work in flight', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		setInFlight(2, 1, 1);

		await pause.advanceHydraHostPause('host-1', { force: true });

		expect(mockStopHostNode).toHaveBeenCalledTimes(2);
	});

	// A partial stop must be retried, so it cannot be recorded as requested.
	it('records nothing when a stop fails, so the next cycle asks again', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockStopHostNode.mockRejectedValueOnce(new Error('host down'));

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockHostUpdateMany).not.toHaveBeenCalled();
	});

	// A stopped node cannot contest a close or post the fanout.
	it('waits while a head on the host is closing or in its dispute window', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		setInFlight(0, 0, 0, 1);

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockStopHostNode).not.toHaveBeenCalled();
	});

	// Serialized with Resume, so a stop can never land after a resume's start.
	it('acts under the per-host pause lock', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockQueryRaw.mockResolvedValue([{ acquired: 1 }]);

		await pause.advanceHydraHostPause('host-1', { force: false });

		const lockCall = mockQueryRaw.mock.calls[0] as unknown[];
		expect((lockCall[0] as string[]).join('?')).toContain('pg_advisory_xact_lock');
		expect(lockCall[1]).toBe('hydra-host-pause:host-1');
		expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(mockStopHostNode.mock.invocationCallOrder[0]);
	});

	it('treats a node the host no longer has as stopped', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockStopHostNode.mockRejectedValueOnce(new FakeHostRequestError('not found', 404));

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockHostUpdateMany).toHaveBeenCalled();
	});
});

describe('getHydraHostPauseState', () => {
	it('reports Paused only when the Host says every node is Stopped', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow({ pauseStopRequestedAt: PAUSED_AT }));
		mockFetchHostNodeHealth.mockResolvedValueOnce({ state: 'Stopped' }).mockResolvedValueOnce({ state: 'Running' });

		expect((await pause.getHydraHostPauseState('host-1')).phase).toBe('Stopping');

		mockFetchHostNodeHealth.mockResolvedValue({ state: 'Stopped' });
		expect((await pause.getHydraHostPauseState('host-1')).phase).toBe('Paused');
	});

	it('reports Active without a pause', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow({ pausedAt: null, pausedNodeIds: [] }));

		expect((await pause.getHydraHostPauseState('host-1')).phase).toBe('Active');
	});
});

describe('resumeHydraHost', () => {
	it('starts the paused nodes, then clears the pause fenced on its timestamp', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow({ pauseStopRequestedAt: PAUSED_AT }));

		await pause.resumeHydraHost('host-1');

		expect(mockStartHostNode).toHaveBeenCalledTimes(2);
		expect(mockHostUpdateMany).toHaveBeenCalledWith({
			where: { id: 'host-1', pausedAt: PAUSED_AT },
			data: { pausedAt: null, pausedNodeIds: [], pauseStopRequestedAt: null },
		});
	});

	// One node removed from the Host by hand must not keep the Host paused forever.
	it('skips a paused node the host no longer has', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockStartHostNode.mockRejectedValueOnce(new FakeHostRequestError('not found', 404));

		await pause.resumeHydraHost('host-1');

		expect(mockHostUpdateMany).toHaveBeenCalled();
	});

	// A half-resumed Host must keep refusing work, or it routes to a stopped node.
	it('stays paused when a node does not start', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockStartHostNode.mockRejectedValueOnce(new Error('boom'));

		await expect(pause.resumeHydraHost('host-1')).rejects.toMatchObject({ status: 502 });
		expect(mockHostUpdateMany).not.toHaveBeenCalled();
	});
});

describe('assertHydraHeadHostNotPaused', () => {
	it('refuses new work on a head whose Host is paused', async () => {
		mockParticipantFindUnique.mockResolvedValue({ HydraHost: { pausedAt: PAUSED_AT } });

		await expect(pause.assertHydraHeadHostNotPaused('head-1')).rejects.toMatchObject({ status: 409 });
	});

	it('allows a head on an active Host, and a head with no local node', async () => {
		mockParticipantFindUnique.mockResolvedValueOnce({ HydraHost: { pausedAt: null } }).mockResolvedValueOnce(null);

		await expect(pause.assertHydraHeadHostNotPaused('head-1')).resolves.toBeUndefined();
		await expect(pause.assertHydraHeadHostNotPaused('head-2')).resolves.toBeUndefined();
	});
});
