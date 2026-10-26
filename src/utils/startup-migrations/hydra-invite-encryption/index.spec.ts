import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { ENCRYPTION_KEY: 'local-test-key-for-invite-backfill' },
}));

const findMany = jest.fn<() => Promise<Array<{ id: string; nonce: string; issuerSignature: string }>>>();
const updateMany =
	jest.fn<
		(input: {
			where: { id: string; nonceHash: null };
			data: { nonce: string; nonceHash: string; issuerSignature: string };
		}) => Promise<{ count: number }>
	>();
const count = jest.fn<() => Promise<number>>();
const findUnique = jest.fn<() => Promise<{ nonceHash: string | null } | null>>();
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHeadInvite: { findMany, updateMany, count, findUnique } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { info: jest.fn() } }));

const { migrateHydraInviteEncryption } = await import('./index');
const { hashInviteNonce, revealInviteNonce, revealInviteSignature } =
	await import('@/services/hydra-invite/invite-secrets');

beforeEach(() => {
	jest.clearAllMocks();
	findMany.mockResolvedValue([{ id: 'invite-1', nonce: 'bearer-nonce', issuerSignature: 'signed-payload' }]);
	updateMany.mockResolvedValue({ count: 1 });
	count.mockResolvedValue(0);
});

describe('migrateHydraInviteEncryption', () => {
	it('backfills old bearer fields before startup continues', async () => {
		await migrateHydraInviteEncryption();
		expect(updateMany).toHaveBeenCalledTimes(1);
		const call = updateMany.mock.calls[0]?.[0];
		if (!call) throw new Error('backfill did not update the invite');
		expect(call.where).toEqual({ id: 'invite-1', nonceHash: null });
		expect(call.data.nonce).not.toBe('bearer-nonce');
		expect(call.data.issuerSignature).not.toBe('signed-payload');
		expect(call.data.nonceHash).toBe(hashInviteNonce('bearer-nonce'));
		expect(revealInviteNonce(call.data)).toBe('bearer-nonce');
		expect(revealInviteSignature(call.data)).toBe('signed-payload');
	});

	it('fails startup if a plaintext row remains', async () => {
		findMany.mockResolvedValue([]);
		count.mockResolvedValue(1);
		await expect(migrateHydraInviteEncryption()).rejects.toThrow(/plaintext row/);
	});
});
