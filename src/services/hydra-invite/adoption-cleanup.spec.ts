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
const remove = jest.fn<() => Promise<void>>();
const forget = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHost: { findMany: async () => [host] },
		hydraHeadInvite: { findUnique: async () => invite, updateMany: async () => ({ count: 1 }) },
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
jest.unstable_mockModule('./invite-signing', () => ({
	verifyHydraRedemption: async () => {
		throw new Error('invalid signature');
	},
}));
jest.unstable_mockModule('./orchestrator', () => ({ createHeadFromExchange: jest.fn() }));
jest.unstable_mockModule('./release-reservation', () => ({ releaseReservedParticipants: release }));
jest.unstable_mockModule('@/services/hydra-node-funding/service', () => ({ fundHydraNodeNow: jest.fn() }));

const { pollHydraRedemptions } = await import('./adoption');

beforeEach(() => {
	jest.clearAllMocks();
	removalRequested = false;
	remove.mockImplementation(async () => {
		removalRequested = true;
	});
	forget.mockImplementation(async () => {
		if (!removalRequested) throw new Error('redemption peer setup is still pending');
	});
	release.mockResolvedValue(undefined);
});

it('cancels rejected redemption setup before forgetting its durable material', async () => {
	expect(await pollHydraRedemptions()).toMatchObject({ rejected: 1 });
	expect(remove).toHaveBeenCalledTimes(1);
	expect(forget).toHaveBeenCalledTimes(1);
	expect(release).toHaveBeenCalledTimes(1);
	expect(remove.mock.invocationCallOrder[0]).toBeLessThan(forget.mock.invocationCallOrder[0]);
});
