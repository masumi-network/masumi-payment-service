import { beforeEach, expect, it, jest } from '@jest/globals';

const host = { id: 'host', baseUrl: 'https://host.example', encryptedAdminToken: 'token', allowInsecureHttp: false };
// Adopted on an earlier run, but the acknowledgement never reached the Host.
const invite = { id: 'invite', nonce: 'nonce', role: 'Issuer', status: 'Completed', hydraHeadId: 'head' };
const fetchRedemptions =
	jest.fn<(baseUrl: string, token: string, since: number) => Promise<{ now: number; invites: object[] }>>();
const forget =
	jest.fn<
		(baseUrl: string, token: string, nonce: string, transport: { allowInsecureHttp: boolean }) => Promise<void>
	>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHost: { findMany: async () => [host] },
		hydraHeadInvite: { findUnique: async () => invite },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: (value: string) => value }));
jest.unstable_mockModule('@/services/hydra-host/client', () => ({
	fetchHostRedemptions: fetchRedemptions,
	forgetHostInvite: forget,
	HydraHostRequestError: Error,
}));
jest.unstable_mockModule('./node-keys', () => ({ deriveNodeCardanoVkey: (key: string) => key }));
jest.unstable_mockModule('./invite-signing', () => ({ verifyHydraRedemption: jest.fn() }));
jest.unstable_mockModule('./orchestrator', () => ({ createHeadFromExchange: jest.fn() }));
jest.unstable_mockModule('./release-reservation', () => ({
	releaseReservedParticipants: jest.fn(),
	canRemoveReservedHostNode: jest.fn(),
}));
jest.unstable_mockModule('@/services/hydra-node-funding/service', () => ({ fundHydraNodeNow: jest.fn() }));

const { pollHydraRedemptions } = await import('./adoption');

beforeEach(() => {
	jest.clearAllMocks();
	fetchRedemptions.mockResolvedValue({
		now: Date.now(),
		// Older than any fixed lookback window: the Host keeps it until acknowledged.
		invites: [{ nonce: 'nonce', redeemedAt: 1, redeemer: {}, redeemerSignature: {} }],
	});
	forget.mockResolvedValue(undefined);
});

it('asks a Host from the beginning on cold start and acknowledges a finished replay', async () => {
	expect(await pollHydraRedemptions()).toEqual({ polled: 1, adopted: 0, rejected: 0 });
	expect(fetchRedemptions.mock.calls[0][2]).toBe(0);
	expect(forget).toHaveBeenCalledWith('https://host.example', 'token', 'nonce', { allowInsecureHttp: false });
});
