import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHostStatus, Network } from '@/generated/prisma/client';

const mockFindUnique = jest.fn<(...args: any[]) => any>();
const mockUpdate = jest.fn<(...args: any[]) => any>();
const mockFindMany = jest.fn<(...args: any[]) => any>();
const mockQueueDisconnect = jest.fn<(...args: any[]) => any>();
const mockGetPauseState = jest.fn<(...args: any[]) => any>();
const mockWithPauseLease = jest.fn<(...args: any[]) => any>();
const LEASE_UNTIL = new Date('2026-10-22T00:16:00Z');

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHost: { findUnique: mockFindUnique, update: mockUpdate },
		hydraLocalParticipant: { findMany: mockFindMany },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({
	encrypt: (value: string) => `encrypted:${value}`,
	decrypt: (value: string) => value.slice('encrypted:'.length),
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ queueDisconnect: mockQueueDisconnect }),
}));
jest.unstable_mockModule('./pause', () => ({
	getHydraHostPauseState: mockGetPauseState,
	withHostPauseLease: mockWithPauseLease,
}));

let updateHydraHost: typeof import('./registry').updateHydraHost;
const host = {
	id: 'host-1',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	updatedAt: new Date('2026-10-01T00:00:00Z'),
	name: 'host',
	network: Network.Preprod,
	baseUrl: 'https://host.example',
	allowInsecureHttp: false,
	publicPeerHost: 'host.example',
	encryptedUserToken: `encrypted:${'u'.repeat(40)}`,
	encryptedAdminToken: `encrypted:${'a'.repeat(40)}`,
	hydraVersion: null,
	releaseVersion: null,
	releaseCommit: null,
	scriptCatalogueHash: null,
	ledgerParamsHash: null,
	status: HydraHostStatus.Active,
	lastHealthAt: null,
	lastHealthError: null,
	pausedAt: new Date('2026-10-22T00:00:00Z'),
	pauseStopRequestedAt: new Date('2026-10-22T00:01:00Z'),
	_count: { Participants: 2 },
};

beforeAll(async () => {
	({ updateHydraHost } = await import('./registry'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockFindUnique.mockResolvedValue(host);
	mockUpdate.mockResolvedValue(host);
	mockFindMany.mockResolvedValue([
		{ hydraHeadId: 'head-1', HydraHead: { isEnabled: true, reconciliationCompletedAt: null } },
		{ hydraHeadId: 'head-2', HydraHead: { isEnabled: true, reconciliationCompletedAt: null } },
	]);
	mockQueueDisconnect.mockResolvedValue(undefined);
	mockGetPauseState.mockResolvedValue({ phase: 'Paused' });
	mockWithPauseLease.mockImplementation(async (_hostId: string, action: (leaseUntil: Date) => Promise<void>) => {
		await action(LEASE_UNTIL);
		return true;
	});
});

describe('Host runtime token rotation', () => {
	it('closes every old session before saving the new token', async () => {
		await updateHydraHost(host.id, { userToken: 'n'.repeat(40) });
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: host.id,
					pauseLeaseUntil: LEASE_UNTIL,
					pausedAt: host.pausedAt,
					pauseStopRequestedAt: host.pauseStopRequestedAt,
				},
			}),
		);
		expect(mockFindMany).toHaveBeenCalledWith({
			where: { hydraHostId: host.id },
			select: {
				hydraHeadId: true,
				HydraHead: { select: { isEnabled: true, reconciliationCompletedAt: true } },
			},
		});
		for (const headId of ['head-1', 'head-2']) {
			expect(mockQueueDisconnect).toHaveBeenCalledWith(headId);
		}
		expect(mockQueueDisconnect.mock.invocationCallOrder[0]).toBeLessThan(mockUpdate.mock.invocationCallOrder[0]);
	});

	it('reads participants only after claiming the lease, so a late Head is disconnected', async () => {
		let hasLease = false;
		mockWithPauseLease.mockImplementation(async (_hostId: string, action: (leaseUntil: Date) => Promise<void>) => {
			hasLease = true;
			try {
				await action(LEASE_UNTIL);
			} finally {
				hasLease = false;
			}
			return true;
		});
		mockFindMany.mockImplementation(async () => {
			expect(hasLease).toBe(true);
			return [{ hydraHeadId: 'late-head', HydraHead: { isEnabled: true, reconciliationCompletedAt: null } }];
		});

		await updateHydraHost(host.id, { userToken: 'n'.repeat(40) });
		expect(mockQueueDisconnect).toHaveBeenCalledWith('late-head');
		expect(mockGetPauseState).toHaveBeenCalledTimes(1);
	});

	it('requires a stopped Host even when its node has not yet joined a Head', async () => {
		mockFindMany.mockResolvedValue([{ hydraHeadId: null, HydraHead: null }]);
		mockGetPauseState.mockResolvedValue({ phase: 'Active' });

		await expect(updateHydraHost(host.id, { userToken: 'n'.repeat(40) })).rejects.toMatchObject({ status: 409 });
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it('does not disturb runtime sessions for an admin-only rotation', async () => {
		await updateHydraHost(host.id, { adminToken: 'b'.repeat(40) });
		expect(mockFindMany).not.toHaveBeenCalled();
		expect(mockQueueDisconnect).not.toHaveBeenCalled();
	});

	it('refuses a token update if Resume changed the pause before the write', async () => {
		mockUpdate.mockRejectedValueOnce({ code: 'P2025' });
		await expect(updateHydraHost(host.id, { userToken: 'n'.repeat(40) })).rejects.toMatchObject({ status: 409 });
		expect(mockQueueDisconnect).toHaveBeenCalledTimes(2);
	});

	it('refuses to save the token after the lease expires and Resume takes it', async () => {
		mockUpdate.mockImplementationOnce(async ({ where }: { where: { pauseLeaseUntil?: Date } }) => {
			expect(where.pauseLeaseUntil).toEqual(LEASE_UNTIL);
			throw { code: 'P2025' };
		});

		await expect(updateHydraHost(host.id, { userToken: 'n'.repeat(40) })).rejects.toMatchObject({ status: 409 });
		expect(mockQueueDisconnect).toHaveBeenCalledTimes(2);
	});

	it('refuses to rotate a user token while live Heads can have in-flight work', async () => {
		mockGetPauseState.mockResolvedValue({ phase: 'Active' });
		await expect(updateHydraHost(host.id, { userToken: 'n'.repeat(40) })).rejects.toMatchObject({ status: 409 });
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(mockQueueDisconnect).not.toHaveBeenCalled();
	});

	it('refuses rotation while the Host still reports a running node', async () => {
		mockGetPauseState.mockResolvedValue({ phase: 'Stopping' });
		await expect(updateHydraHost(host.id, { userToken: 'n'.repeat(40) })).rejects.toMatchObject({ status: 409 });
		expect(mockGetPauseState).toHaveBeenCalledWith(host.id, 'n'.repeat(40));
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(mockQueueDisconnect).not.toHaveBeenCalled();
	});

	it('refuses rotation while a Resume holds the Host pause lease', async () => {
		mockWithPauseLease.mockResolvedValue(false);
		await expect(updateHydraHost(host.id, { userToken: 'n'.repeat(40) })).rejects.toMatchObject({ status: 409 });
		expect(mockGetPauseState).not.toHaveBeenCalled();
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it('does not save the secret if a session cannot close and tries the other heads', async () => {
		mockQueueDisconnect.mockRejectedValueOnce(new Error('failed to close'));
		await expect(updateHydraHost(host.id, { userToken: 'n'.repeat(40) })).rejects.toMatchObject({ status: 503 });
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(mockQueueDisconnect).toHaveBeenCalledTimes(2);
	});
});
