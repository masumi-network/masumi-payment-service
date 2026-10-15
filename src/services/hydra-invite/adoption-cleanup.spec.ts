import { beforeEach, expect, it, jest } from '@jest/globals';

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
	jest.fn<
		(
			baseUrl: string,
			token: string,
			nodeId: string,
			options: { force: boolean; allowInsecureHttp: boolean },
		) => Promise<void>
	>();
const forget = jest.fn<() => Promise<void>>();
const canRemove = jest.fn<() => Promise<boolean>>();
const updateMany = jest.fn<(args: { data: { status: string } }) => Promise<{ count: number }>>();
const participantCount = jest.fn<(args: { where: { hydraHeadId?: { not: null } } }) => Promise<number>>();
const verify = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHost: { findMany: async () => [host] },
		hydraHeadInvite: { findUnique: async () => invite, updateMany },
		hydraLocalParticipant: { count: participantCount, findFirst: async () => null },
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
	HydraHostRequestError: class extends Error {},
}));
jest.unstable_mockModule('./invite-signing', () => ({ verifyHydraRedemption: verify }));
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
	updateMany.mockResolvedValue({ count: 1 });
	participantCount.mockResolvedValue(0);
	verify.mockRejectedValue(new Error('invalid signature'));
});

it('marks a forged redemption failed and force-removes the node it peered', async () => {
	expect(await pollHydraRedemptions()).toMatchObject({ rejected: 1 });
	expect(updateMany.mock.calls[0][0].data.status).toBe('Failed');
	// The Host refuses a plain removal once the forged peer is set.
	expect(remove).toHaveBeenCalledWith('https://host.example', 'token', 'node', {
		force: true,
		allowInsecureHttp: false,
	});
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

it('keeps a node a head claims, even for a forged redemption', async () => {
	participantCount.mockResolvedValue(1);
	forget.mockResolvedValue(undefined);
	expect(await pollHydraRedemptions()).toMatchObject({ rejected: 1 });
	expect(updateMany.mock.calls[0][0].data.status).toBe('Failed');
	expect(participantCount.mock.calls[0][0].where).toEqual({
		hydraHostId: 'host',
		hostNodeId: 'node',
		hydraHeadId: { not: null },
	});
	expect(remove).not.toHaveBeenCalled();
	expect(release).not.toHaveBeenCalled();
});

it('revokes without force when a verified redemption has no participant', async () => {
	verify.mockResolvedValue(undefined);
	expect(await pollHydraRedemptions()).toMatchObject({ rejected: 1 });
	expect(updateMany.mock.calls[0][0].data.status).toBe('Revoked');
	expect(remove).toHaveBeenCalledWith('https://host.example', 'token', 'node', {
		force: false,
		allowInsecureHttp: false,
	});
});
