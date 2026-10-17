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
		hydraLocalParticipant: { findUnique: mockParticipantFindUnique, findMany: mockParticipantFindMany },
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

/** The stop time the first advance recorded. */
function recordedStopAt(): Date {
	const write = mockHostUpdateMany.mock.calls.find(
		(call) => (call[0] as { data: { pauseStopRequestedAt?: Date } }).data.pauseStopRequestedAt instanceof Date,
	);
	if (!write) throw new Error('no stop was recorded');
	return (write[0] as { data: { pauseStopRequestedAt: Date } }).data.pauseStopRequestedAt;
}

/** How many stops the next scheduler cycle sends for the pause just advanced. */
async function stopsSentOnNextCycle(): Promise<number> {
	const requestedAt = recordedStopAt();
	mockStopHostNode.mockClear();
	mockHostFindMany.mockResolvedValue([{ id: 'host-1' }]);
	mockHostFindUnique.mockResolvedValue(
		hostRow({ pausedNodeIds: ['node-a', 'node-b'], pauseStopRequestedAt: requestedAt }),
	);
	await pause.runHydraHostPauseCycle();
	return mockStopHostNode.mock.calls.length;
}

beforeEach(() => {
	jest.clearAllMocks();
	pause.resetHydraHostPauseMemory();
	setInFlight(0);
	mockHostUpdateMany.mockResolvedValue({ count: 1 });
	mockParticipantFindMany.mockResolvedValue([{ hostNodeId: 'node-a' }, { hostNodeId: 'node-b' }]);
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

	// The 409 refuses only the force: the pause itself is recorded and drains.
	it('keeps the recorded pause when a forced first pause finds the lease busy', async () => {
		mockQueryRaw.mockResolvedValue([{ pausedAt: null, encryptedAdminToken: 'admin' }]);
		mockParticipantFindMany.mockResolvedValue([{ hostNodeId: 'node-a' }]);
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockHostUpdateMany.mockResolvedValueOnce({ count: 0 });

		await expect(pause.pauseHydraHost('host-1', { force: true })).rejects.toMatchObject({
			status: 409,
			message: expect.stringMatching(/another pause action/),
		});
		expect(mockHostUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ pausedAt: expect.any(Date) }) }),
		);
		expect(mockStopHostNode).not.toHaveBeenCalled();
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
	// Recorded first, so every guard treats the nodes as down before the first stop.
	it('records the stop, then stops every paused node once nothing is in flight', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockHostUpdateMany).toHaveBeenCalledWith({
			where: { id: 'host-1', pausedAt: PAUSED_AT, pauseStopRequestedAt: null },
			data: { pausedNodeIds: ['node-a', 'node-b'], pauseStopRequestedAt: expect.any(Date) },
		});
		expect(mockHostUpdateMany.mock.invocationCallOrder[1]).toBeLessThan(mockStopHostNode.mock.invocationCallOrder[0]);
		expect(mockStopHostNode.mock.calls.map((call) => call[2])).toEqual(['node-a', 'node-b']);
	});

	it('stops at once when forced, even with work in flight', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		setInFlight(2, 1, 1);

		await pause.advanceHydraHostPause('host-1', { force: true });

		expect(mockStopHostNode).toHaveBeenCalledTimes(2);
	});

	// Its node would otherwise run through the upgrade, and Resume would not know it.
	it('also stops and records a node whose head formed after the pause started', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockParticipantFindMany.mockResolvedValue([{ hostNodeId: 'node-a' }, { hostNodeId: 'node-c' }]);

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockHostUpdateMany).toHaveBeenCalledWith({
			where: { id: 'host-1', pausedAt: PAUSED_AT, pauseStopRequestedAt: null },
			data: { pausedNodeIds: ['node-a', 'node-b', 'node-c'], pauseStopRequestedAt: expect.any(Date) },
		});
		expect(mockStopHostNode.mock.calls.map((call) => call[2])).toEqual(['node-a', 'node-b', 'node-c']);
	});

	// An overrun lease let Resume end the pause; stopping now would hit an active Host.
	it('stops nothing when the pause ended before the new nodes were recorded', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockParticipantFindMany.mockResolvedValue([{ hostNodeId: 'node-c' }]);
		mockHostUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockStopHostNode).not.toHaveBeenCalled();
	});

	// A row its own claim would fail is resolved only by a new request, which the
	// pause refuses, so waiting for it would drain forever.
	it('does not wait for top-ups and withdrawals their own claims treat as abandoned', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		const before = Date.now();

		await pause.advanceHydraHostPause('host-1', { force: false });

		const topupWhere = mockTopupCount.mock.calls[0][0].where as {
			OR: [{ status: string; createdAt: { gte: Date } }, { status: { in: string[] } }];
		};
		expect(topupWhere.OR[0].status).toBe('Preparing');
		expect(before - topupWhere.OR[0].createdAt.gte.getTime()).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
		expect(topupWhere.OR[1].status.in).toEqual(['Pending', 'Confirmed']);

		const decommitWhere = mockDecommitCount.mock.calls[0][0].where as {
			OR: [
				{ status: string; createdAt: { gte: Date } },
				{ status: string; updatedAt: { gte: Date } },
				{ status: string },
			];
		};
		expect(decommitWhere.OR[0].status).toBe('Preparing');
		expect(before - decommitWhere.OR[0].createdAt.gte.getTime()).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
		expect(decommitWhere.OR[1].status).toBe('Pending');
		expect(before - decommitWhere.OR[1].updatedAt.gte.getTime()).toBeGreaterThanOrEqual(60 * 60_000 - 1000);
		expect(decommitWhere.OR[2]).toEqual({ status: 'Approved' });
	});

	// A forced stop that partly failed must not wait for the drain it skipped.
	it('sends a failed stop again on the next cycle, even with work in flight', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		setInFlight(0, 1);
		mockStopHostNode.mockRejectedValueOnce(new Error('host down'));
		await pause.advanceHydraHostPause('host-1', { force: true });
		const requestedAt = recordedStopAt();

		mockStopHostNode.mockClear();
		mockHostFindMany.mockResolvedValue([{ id: 'host-1' }]);
		mockHostFindUnique.mockResolvedValue(
			hostRow({ pausedNodeIds: ['node-a', 'node-b'], pauseStopRequestedAt: requestedAt }),
		);
		await pause.runHydraHostPauseCycle();
		expect(mockStopHostNode.mock.calls.map((call) => call[2])).toEqual(['node-a', 'node-b']);

		// Every stop now succeeded, so the cycle after stops asking.
		mockStopHostNode.mockClear();
		await pause.runHydraHostPauseCycle();
		expect(mockStopHostNode).not.toHaveBeenCalled();
	});

	// A stopped node cannot contest a close or post the fanout.
	it('waits while a head on the host is closing or in its dispute window', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		setInFlight(0, 0, 0, 1);

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockStopHostNode).not.toHaveBeenCalled();
	});

	// Serialized with Resume, so a stop can never land after a resume's start.
	it('acts only while it holds the pause lease, and releases it', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());

		await pause.advanceHydraHostPause('host-1', { force: false });

		const claim = mockHostUpdateMany.mock.calls[0][0] as {
			where: { OR: Array<{ pauseLeaseUntil: unknown }> };
			data: { pauseLeaseUntil: Date };
		};
		// Claimable only when free or expired: compared with now, not with the new end.
		const before = Date.now();
		expect(claim.where).toEqual({
			id: 'host-1',
			OR: [{ pauseLeaseUntil: null }, { pauseLeaseUntil: { lt: expect.any(Date) } }],
		});
		const expiredBefore = (claim.where.OR[1].pauseLeaseUntil as { lt: Date }).lt;
		expect(expiredBefore.getTime()).toBeLessThanOrEqual(before);
		expect(claim.data.pauseLeaseUntil.getTime()).toBeGreaterThan(before);
		expect(mockHostUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(mockStopHostNode.mock.invocationCallOrder[0]);
		// Released fenced on its own value, so it never clears a later holder's lease.
		expect(mockHostUpdateMany).toHaveBeenLastCalledWith({
			where: { id: 'host-1', pauseLeaseUntil: claim.data.pauseLeaseUntil },
			data: { pauseLeaseUntil: null },
		});
	});

	it('does nothing while another instance holds the lease', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockHostUpdateMany.mockResolvedValueOnce({ count: 0 });

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockStopHostNode).not.toHaveBeenCalled();
	});

	// A dropped force would quietly wait for the in-flight work after all.
	it('refuses a forced advance with 409 while another instance holds the lease', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockHostUpdateMany.mockResolvedValueOnce({ count: 0 });

		await expect(pause.advanceHydraHostPause('host-1', { force: true })).rejects.toMatchObject({ status: 409 });
		expect(mockStopHostNode).not.toHaveBeenCalled();
	});

	// isClosing stays set after Final, so it must not hold a pause forever.
	it('counts a closing head only while it is still Open, plus Closed and FanoutPossible', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockHeadCount).toHaveBeenCalledWith({
			where: {
				LocalParticipant: { hydraHostId: 'host-1' },
				OR: [{ isClosing: true, status: 'Open' }, { status: { in: ['Closed', 'FanoutPossible'] } }],
			},
		});
	});

	// A base URL missing a proxy prefix also answers 404; that is not a stopped node.
	it('does not take a 404 from a wrong URL as a missing node', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockStopHostNode.mockRejectedValueOnce(
			new FakeHostRequestError('POST /v1/nodes/node-a/stop failed (404): not found', 404),
		);

		await pause.advanceHydraHostPause('host-1', { force: false });
		expect(await stopsSentOnNextCycle()).toBe(2);
	});

	// One timeout per cycle, not one per node, so the lease does not keep Resume out.
	it('stops trying the other nodes when the host does not answer at all', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockStopHostNode.mockRejectedValueOnce(new FakeHostRequestError('could not reach the hydra host', null));

		await pause.advanceHydraHostPause('host-1', { force: false });

		expect(mockStopHostNode).toHaveBeenCalledTimes(1);
		expect(await stopsSentOnNextCycle()).toBe(2);
	});

	it('treats a node the host no longer has as stopped', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockStopHostNode.mockRejectedValueOnce(new FakeHostRequestError('failed (404): no such node: node-a', 404));

		await pause.advanceHydraHostPause('host-1', { force: false });
		expect(await stopsSentOnNextCycle()).toBe(0);
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

	// The stop is not recorded yet, so a later cycle still has to ask the Host.
	it('reports Stopping, not Paused, while the stop is not recorded', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());

		const state = await pause.getHydraHostPauseState('host-1');

		expect(state.phase).toBe('Stopping');
		expect(state.nodes.map((node) => node.state)).toEqual(['Stopped', 'Stopped']);
	});

	it('does not probe the nodes while draining', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		setInFlight(1);

		expect((await pause.getHydraHostPauseState('host-1')).phase).toBe('Draining');
		expect(mockFetchHostNodeHealth).not.toHaveBeenCalled();
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
		mockStartHostNode.mockRejectedValueOnce(new FakeHostRequestError('failed (404): no such node: node-a', 404));

		await pause.resumeHydraHost('host-1');

		expect(mockHostUpdateMany).toHaveBeenCalled();
	});

	// A half-resumed Host must keep refusing work, or it routes to a stopped node.
	it('stays paused when a node does not start', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockStartHostNode.mockRejectedValueOnce(new Error('boom'));

		await expect(pause.resumeHydraHost('host-1')).rejects.toMatchObject({ status: 502 });
		expect(mockHostUpdateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ pausedAt: null }) }),
		);
	});

	it('releases the lease when the resume fails', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockStartHostNode.mockRejectedValueOnce(new Error('boom'));

		await expect(pause.resumeHydraHost('host-1')).rejects.toMatchObject({ status: 502 });
		const claim = mockHostUpdateMany.mock.calls[0][0] as { data: { pauseLeaseUntil: Date } };
		expect(mockHostUpdateMany).toHaveBeenLastCalledWith({
			where: { id: 'host-1', pauseLeaseUntil: claim.data.pauseLeaseUntil },
			data: { pauseLeaseUntil: null },
		});
	});

	it('refuses with 409 while an advance holds the lease', async () => {
		mockHostFindUnique.mockResolvedValue(hostRow());
		mockHostUpdateMany.mockResolvedValueOnce({ count: 0 });

		await expect(pause.resumeHydraHost('host-1')).rejects.toMatchObject({ status: 409 });
		expect(mockStartHostNode).not.toHaveBeenCalled();
	});
});

describe('runHydraHostPauseCycle', () => {
	// The cycle discards the state, so it must not pay for a health probe per node.
	it('stops the nodes of a drained pause without probing them', async () => {
		mockHostFindMany.mockResolvedValue([{ id: 'host-1' }]);
		mockHostFindUnique.mockResolvedValue(hostRow());

		await pause.runHydraHostPauseCycle();

		expect(mockStopHostNode).toHaveBeenCalledTimes(2);
		expect(mockFetchHostNodeHealth).not.toHaveBeenCalled();
	});
});

describe('assertHydraHeadHostNotStopping', () => {
	it('allows drain work while the pause only drains, and on an active host', async () => {
		mockParticipantFindUnique
			.mockResolvedValueOnce({ HydraHost: { pausedAt: PAUSED_AT, pauseStopRequestedAt: null } })
			.mockResolvedValueOnce({ HydraHost: { pausedAt: null, pauseStopRequestedAt: null } });

		await expect(pause.assertHydraHeadHostNotStopping('head-1')).resolves.toBeUndefined();
		await expect(pause.assertHydraHeadHostNotStopping('head-1')).resolves.toBeUndefined();
	});

	it('refuses once the pause has recorded its stop', async () => {
		mockParticipantFindUnique.mockResolvedValue({
			HydraHost: { pausedAt: PAUSED_AT, pauseStopRequestedAt: PAUSED_AT },
		});

		await expect(pause.assertHydraHeadHostNotStopping('head-1')).rejects.toMatchObject({ status: 409 });
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
