import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeRegistryStore } from '@masumi/hydra-host/registry/store';
import { requestRemoval } from '@masumi/hydra-host/api/transitions';
import type { HostApiError } from '@masumi/hydra-host/api/http-error';

const host = { id: 'host', baseUrl: 'https://host.example', encryptedAdminToken: 'token', allowInsecureHttp: false };
const invite = {
	id: 'invite',
	nonce: 'nonce',
	hostNodeId: 'node',
	hydraHostId: 'host',
	role: 'Issuer',
	status: 'Issued',
	hydraHeadId: null,
	network: 'Preprod',
	HydraHost: host,
};
let removalRequested = false;
const release = jest.fn<() => Promise<void>>();
const remove =
	jest.fn<(baseUrl: string, adminToken: string, nodeId: string, options: { force: boolean }) => Promise<void>>();
const forget = jest.fn<() => Promise<void>>();
const canRemove = jest.fn<() => Promise<boolean>>();
const verify = jest.fn<() => Promise<void>>();
const unboundParticipant = jest.fn<() => Promise<{ id: string; autoFund: boolean } | null>>();
const claimingParticipants = jest.fn<() => Promise<number>>();

class HydraHostRequestError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
	}
}

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHost: { findMany: async () => [host] },
		hydraHeadInvite: { findUnique: async () => invite, updateMany: async () => ({ count: 1 }) },
		hydraLocalParticipant: { findFirst: unboundParticipant, count: claimingParticipants },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: (value: string) => value }));
jest.unstable_mockModule('@/services/hydra-host/client', () => ({
	fetchHostRedemptions: async () => ({
		now: Date.now(),
		invites: [{ nonce: 'nonce', redeemedAt: Date.now(), redeemer: {}, redeemerSignature: {} }],
	}),
	forgetHostInvite: forget,
	removeHostNode: remove,
	HydraHostRequestError,
}));
jest.unstable_mockModule('./invite-signing', () => ({
	verifyHydraRedemption: verify,
}));
jest.unstable_mockModule('./orchestrator', () => ({ createHeadFromExchange: jest.fn() }));
jest.unstable_mockModule('./release-reservation', () => ({
	releaseReservedParticipants: release,
	canRemoveReservedHostNode: canRemove,
}));
jest.unstable_mockModule('@/services/hydra-node-funding/service', () => ({ fundHydraNodeNow: jest.fn() }));

const { pollHydraRedemptions } = await import('./adoption');

beforeEach(() => {
	jest.clearAllMocks();
	removalRequested = false;
	canRemove.mockResolvedValue(true);
	remove.mockImplementation(async () => {
		removalRequested = true;
	});
	forget.mockImplementation(async () => {
		if (!removalRequested) throw new Error('redemption peer setup is still pending');
	});
	release.mockResolvedValue(undefined);
	verify.mockRejectedValue(new Error('invalid signature'));
	unboundParticipant.mockResolvedValue(null);
	claimingParticipants.mockResolvedValue(0);
});

it('cancels rejected redemption setup before forgetting its durable material', async () => {
	expect(await pollHydraRedemptions()).toMatchObject({ rejected: 1 });
	expect(remove).toHaveBeenCalledTimes(1);
	expect(forget).toHaveBeenCalledTimes(1);
	expect(release).toHaveBeenCalledTimes(1);
	expect(remove.mock.invocationCallOrder[0]).toBeLessThan(forget.mock.invocationCallOrder[0]);
});

it('keeps the Host signer when rejected redemption belongs to a legacy participant', async () => {
	canRemove.mockResolvedValue(false);
	forget.mockResolvedValue(undefined);
	expect(await pollHydraRedemptions()).toMatchObject({ rejected: 1 });
	expect(remove).not.toHaveBeenCalled();
	expect(release).toHaveBeenCalledTimes(1);
});

// The Host's own removal guard, on a node in the state a redemption leaves it:
// escrow acknowledged at issuance, and the redeemer set as its peer.
let dataDir: string;
afterEach(async () => {
	if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

async function driveRealHostGuard(): Promise<NodeRegistryStore> {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adoption-cleanup-'));
	const store = new NodeRegistryStore(dataDir);
	await store.write({
		nodeId: 'node',
		state: 'Running',
		desired: 'Running',
		network: 'preprod',
		apiPort: 4001,
		peerPort: 5001,
		monitoringPort: 6001,
		advertise: 'hydra1.example.com:5001',
		peers: [
			{
				advertise: 'redeemer.example.com:5001',
				hydraVerificationKey: `5820${'ab'.repeat(32)}`,
				cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
			},
		],
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		depositActivationSeconds: 300,
		unsyncedPeriodSeconds: 1800,
		hydraVerificationKey: '5820aa',
		cardanoVerificationKey: '5820bb',
		escrowAckedAt: '2026-07-28T11:00:00.000Z',
		idempotencyKey: 'idem-1',
		createdAt: '2026-07-28T11:00:00.000Z',
		updatedAt: '2026-07-28T11:00:00.000Z',
		startAttempts: 0,
		lastStopUndrained: false,
	});
	remove.mockImplementation(async (_baseUrl, _adminToken, nodeId, { force }) => {
		try {
			await requestRemoval(store, nodeId, { force });
		} catch (error) {
			throw new HydraHostRequestError((error as Error).message, (error as HostApiError).status);
		}
		removalRequested = true;
	});
	return store;
}

it('removes the node of a verified redemption nobody here claims, past the Host guard', async () => {
	verify.mockResolvedValue(undefined);
	const store = await driveRealHostGuard();

	expect(await pollHydraRedemptions()).toMatchObject({ rejected: 1 });
	expect(await store.read('node')).toMatchObject({ state: 'Removing', removalRequested: true });
	expect(remove).toHaveBeenCalledWith(host.baseUrl, 'token', 'node', expect.objectContaining({ force: true }));
	expect(forget).toHaveBeenCalledTimes(1);
	expect(release).toHaveBeenCalledTimes(1);
});

it('keeps the node of a verified redemption when a head still claims it', async () => {
	verify.mockResolvedValue(undefined);
	claimingParticipants.mockResolvedValue(1);
	forget.mockResolvedValue(undefined);
	const store = await driveRealHostGuard();

	expect(await pollHydraRedemptions()).toMatchObject({ rejected: 1 });
	expect(remove).not.toHaveBeenCalled();
	expect(await store.read('node')).toMatchObject({ state: 'Running' });
	expect(release).not.toHaveBeenCalled();
});
