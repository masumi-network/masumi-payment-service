import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';

const expiredAt = new Date('2026-01-01T00:00:00.000Z');
const findMany = jest.fn<() => Promise<object[]>>();
const update = jest.fn<() => Promise<object>>();
const release = jest.fn<() => Promise<void>>();
const fetchHostRedemptions = jest.fn<() => Promise<object>>();
const forgetHostInvite = jest.fn<() => Promise<void>>();
const removeHostNode = jest.fn<() => Promise<void>>();
const canRemoveReservedHostNode = jest.fn<() => Promise<boolean>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHeadInvite: { findMany, update } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({
	encrypt: (value: string) => value,
	decrypt: (value: string) => (value === 'sealed-nonce' ? 'nonce' : value),
}));
jest.unstable_mockModule('@/services/hydra-host/client', () => ({
	fetchHostRedemptions,
	forgetHostInvite,
	removeHostNode,
}));
jest.unstable_mockModule('@/services/hydra-host/node-gone', () => ({ isHostNodeGone: () => false }));
jest.unstable_mockModule('./node-keys', () => ({ deriveNodeCardanoVkey: jest.fn() }));
jest.unstable_mockModule('./invite-signing', () => ({ verifyHydraRedemption: jest.fn() }));
jest.unstable_mockModule('./orchestrator', () => ({ createHeadFromExchange: jest.fn() }));
jest.unstable_mockModule('./release-reservation', () => ({
	releaseReservedParticipants: release,
	canRemoveReservedHostNode,
}));
jest.unstable_mockModule('@/services/hydra-node-funding/service', () => ({ fundHydraNodeNow: jest.fn() }));

const { reapExpiredInvites } = await import('./adoption');

beforeEach(() => {
	jest.clearAllMocks();
	jest.spyOn(Date, 'now').mockReturnValue(expiredAt.getTime() + 48 * 60 * 60 * 1000);
	update.mockResolvedValue({});
	release.mockResolvedValue(undefined);
	fetchHostRedemptions.mockRejectedValue(new Error('host unreachable'));
	forgetHostInvite.mockResolvedValue(undefined);
	removeHostNode.mockResolvedValue(undefined);
	canRemoveReservedHostNode.mockResolvedValue(true);
});
afterEach(() => {
	jest.restoreAllMocks();
});

describe('expired invite with an unknown Host state', () => {
	it.each([
		['missing admin credentials', null],
		['a long Host outage', 'admin-token'],
	])('does not release a potentially live node after %s', async (_scenario, adminToken) => {
		findMany.mockResolvedValue([
			{
				id: 'invite',
				nonce: 'nonce',
				hydraHostId: 'host',
				hostNodeId: 'node',
				expiresAt: expiredAt,
				HydraHost: {
					baseUrl: 'https://host.example',
					encryptedAdminToken: adminToken,
					allowInsecureHttp: false,
				},
			},
		]);

		expect(await reapExpiredInvites()).toBe(0);
		expect(update).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
	});

	it('releases a confirmed unredeemed invite after Host cleanup', async () => {
		findMany.mockResolvedValue([
			{
				id: 'invite',
				nonce: 'nonce',
				hydraHostId: 'host',
				hostNodeId: 'node',
				expiresAt: expiredAt,
				HydraHost: {
					baseUrl: 'https://host.example',
					encryptedAdminToken: 'admin-token',
					allowInsecureHttp: false,
				},
			},
		]);
		fetchHostRedemptions.mockResolvedValue({ invites: [], unreadableNonces: [], now: Date.now() });

		expect(await reapExpiredInvites()).toBe(1);
		expect(forgetHostInvite).toHaveBeenCalledTimes(1);
		expect(removeHostNode).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	// The Host lists only redeemed records and refuses to forget one without a discard.
	it('keeps an invite whose redeemed Host record is unreadable', async () => {
		findMany.mockResolvedValue([
			{
				id: 'invite',
				nonce: 'nonce',
				hydraHostId: 'host',
				hostNodeId: 'node',
				expiresAt: expiredAt,
				HydraHost: {
					baseUrl: 'https://host.example',
					encryptedAdminToken: 'admin-token',
					allowInsecureHttp: false,
				},
			},
		]);
		fetchHostRedemptions.mockResolvedValue({ invites: [], unreadableNonces: ['nonce'], now: Date.now() });

		expect(await reapExpiredInvites()).toBe(0);
		expect(forgetHostInvite).not.toHaveBeenCalled();
		expect(removeHostNode).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
	});

	it('keeps an encrypted invite whose Host redemption is unreadable', async () => {
		findMany.mockResolvedValue([
			{
				id: 'invite',
				nonce: 'sealed-nonce',
				nonceHash: createHash('sha256').update('nonce').digest('hex'),
				hydraHostId: 'host',
				hostNodeId: 'node',
				expiresAt: expiredAt,
				HydraHost: {
					baseUrl: 'https://host.example',
					encryptedAdminToken: 'admin-token',
					allowInsecureHttp: false,
				},
			},
		]);
		fetchHostRedemptions.mockResolvedValue({ invites: [], unreadableNonces: ['nonce'], now: Date.now() });

		expect(await reapExpiredInvites()).toBe(0);
		expect(forgetHostInvite).not.toHaveBeenCalled();
		expect(removeHostNode).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
	});
});
