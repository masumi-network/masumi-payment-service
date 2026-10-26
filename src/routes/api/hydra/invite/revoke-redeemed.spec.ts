import { beforeEach, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus } from '@/generated/prisma/client';

// Redeemed on the Host, but never adopted: the invite here is still Issued.
const host = { baseUrl: 'https://host.example', encryptedAdminToken: 'token', allowInsecureHttp: false };
const invite = {
	id: 'invite',
	nonce: 'nonce',
	nonceHash: null as string | null,
	role: 'Issuer',
	status: 'Issued',
	hydraHostId: 'host',
	hostNodeId: 'node',
	HydraHost: host,
};
const updateMany = jest.fn<(args: { data: { status: string } }) => Promise<{ count: number }>>();
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
const release = jest.fn<() => Promise<{ retained: number }>>();
const findMany = jest.fn<(...args: any[]) => Promise<any[]>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: async () => ({
				id: 'admin-key',
				status: ApiKeyStatus.Active,
				canRead: true,
				canPay: true,
				canAdmin: true,
				usageLimited: false,
				networkLimit: [],
				WalletScopes: [],
				X402WalletScopes: [],
			}),
		},
		hydraHeadInvite: {
			findMany,
			findUnique: async () => invite,
			findUniqueOrThrow: async () => invite,
			updateMany: async (args: { data: { status: string } }) => {
				const result = await updateMany(args);
				if (result.count === 1) invite.status = args.data.status;
				return result;
			},
		},
		hydraLocalParticipant: { count: async () => 0 },
	},
}));
const actualEncryption = await import('@/utils/security/encryption');
jest.unstable_mockModule('@/utils/security/encryption', () => ({
	...actualEncryption,
	decrypt: (value: string) => (value === 'sealed-nonce' ? 'nonce' : value),
}));
const READABLE = {
	invites: [{ nonce: 'nonce', redeemedAt: 1, redeemer: {}, redeemerSignature: {} }],
	unreadableNonces: [],
};
// The Host lists only redeemed records, so one this service cannot parse is still held there.
const UNREADABLE = { invites: [], unreadableNonces: ['nonce'] };
let heldByHost: { invites: object[]; unreadableNonces: string[] } = READABLE;
// Other Hydra modules the route loads import more of the client than this test drives.
const actualClient = await import('@/services/hydra-host/client');
jest.unstable_mockModule('@/services/hydra-host/client', () => ({
	...actualClient,
	fetchHostRedemptions: async () => ({ now: Date.now(), ...heldByHost }),
	forgetHostInvite: forget,
	removeHostNode: remove,
}));
jest.unstable_mockModule('@/services/hydra-invite/release-reservation', () => ({
	releaseReservedParticipants: release,
	canRemoveReservedHostNode: async () => true,
}));
jest.unstable_mockModule('@/services/hydra-invite/orchestrator', () => ({
	createHeadFromExchange: jest.fn(),
	mintHeadInvite: jest.fn(),
	redeemHeadInvite: jest.fn(),
}));
jest.unstable_mockModule('@/services/hydra-node-funding/service', () => ({ fundHydraNodeNow: jest.fn() }));

const { deleteInviteDelete, queryInviteGet } = await import('./index');

const revoke = (body: Record<string, unknown>) =>
	testEndpoint({
		endpoint: deleteInviteDelete,
		requestProps: { method: 'DELETE', headers: { token: 'admin-key' }, body: { id: 'invite', ...body } },
		responseOptions: { eventEmitter: EventEmitter },
		// The app reads DELETE input from the body (src/app.ts); the default reads the query.
		configProps: { inputSources: { delete: ['body', 'params'] } },
	});

beforeEach(() => {
	jest.clearAllMocks();
	invite.status = 'Issued';
	invite.nonce = 'nonce';
	invite.nonceHash = null;
	heldByHost = READABLE;
	updateMany.mockResolvedValue({ count: 1 });
	remove.mockResolvedValue(undefined);
	forget.mockResolvedValue(undefined);
	release.mockResolvedValue({ retained: 0 });
	findMany.mockResolvedValue([]);
});

it('resumes the invite list from an inclusive cursor in stable newest-first order', async () => {
	const { responseMock } = await testEndpoint({
		endpoint: queryInviteGet,
		requestProps: {
			method: 'GET',
			headers: { token: 'admin-key' },
			query: { limit: '2', cursorId: 'older-invite', network: 'Preprod' },
		},
		responseOptions: { eventEmitter: EventEmitter },
	});

	expect(responseMock.statusCode).toBe(200);
	expect(findMany).toHaveBeenCalledWith({
		where: { network: 'Preprod' },
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
		take: 2,
		cursor: { id: 'older-invite' },
	});
});

it.each([
	['a redeemed invite', READABLE],
	['an invite whose redeemed record is unreadable', UNREADABLE],
])('refuses %s unless the operator asks to discard the redemption', async (_scenario, held) => {
	heldByHost = held;
	const { responseMock } = await revoke({});
	expect(responseMock.statusCode).toBe(409);
	expect(updateMany).not.toHaveBeenCalled();
	expect(remove).not.toHaveBeenCalled();
	expect(forget).not.toHaveBeenCalled();
});

it('keeps an encrypted invite when the Host redemption is unreadable', async () => {
	invite.nonce = 'sealed-nonce';
	invite.nonceHash = createHash('sha256').update('nonce').digest('hex');
	heldByHost = UNREADABLE;

	const { responseMock } = await revoke({});
	expect(responseMock.statusCode).toBe(409);
	expect(updateMany).not.toHaveBeenCalled();
	expect(forget).not.toHaveBeenCalled();
});

it.each([
	['an unadopted redemption', READABLE],
	['an unreadable redemption', UNREADABLE],
])('cancels %s: revoked, node force-removed, then forgotten and released', async (_scenario, held) => {
	heldByHost = held;
	const { responseMock } = await revoke({ discardRedemption: true });
	expect(responseMock.statusCode).toBe(200);
	expect(responseMock._getJSONData().data).toEqual({ id: 'invite', status: 'Revoked' });
	expect(remove).toHaveBeenCalledWith('https://host.example', 'token', 'node', {
		force: true,
		allowInsecureHttp: false,
	});
	expect(remove.mock.invocationCallOrder[0]).toBeLessThan(forget.mock.invocationCallOrder[0]);
	expect(release).toHaveBeenCalledTimes(1);
});

it('does not undo a redemption that adoption carried to a head first', async () => {
	// Adoption links the invite to a head between the route's check and its write.
	updateMany.mockImplementation(async () => {
		invite.status = 'Completed';
		return { count: 0 };
	});
	const { responseMock } = await revoke({ discardRedemption: true });
	expect(responseMock.statusCode).toBe(409);
	expect(remove).not.toHaveBeenCalled();
	expect(forget).not.toHaveBeenCalled();
});
