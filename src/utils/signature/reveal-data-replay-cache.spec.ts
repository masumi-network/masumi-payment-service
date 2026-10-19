import { jest } from '@jest/globals';
import { Prisma } from '@/generated/prisma/client';

const mockCreate = jest.fn(async () => ({ digest: 'abc' }));
const mockFindUnique = jest.fn(async () => null as { digest: string; validUntil: Date } | null);
const mockDeleteMany = jest.fn(async () => ({ count: 3 }));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		revealSignatureUsage: {
			create: mockCreate,
			findUnique: mockFindUnique,
			deleteMany: mockDeleteMany,
		},
	},
}));

const { markRevealSignatureUsed, pruneExpiredRevealSignatureUsage } = await import('./reveal-data-replay-cache');

describe('reveal-data-replay-cache', () => {
	beforeEach(() => {
		mockCreate.mockReset();
		mockFindUnique.mockReset();
		mockDeleteMany.mockReset();
		mockCreate.mockImplementation(async () => ({ digest: 'abc' }));
		mockDeleteMany.mockImplementation(async () => ({ count: 3 }));
	});

	it('returns recorded when digest is first inserted', async () => {
		await expect(
			markRevealSignatureUsed({
				signature: 'sig',
				key: 'key',
				blockchainIdentifier: 'chain',
				validUntil: Date.now() + 60_000,
			}),
		).resolves.toEqual({ status: 'recorded' });
	});

	it('allows idempotent retry while validUntil is still in the future', async () => {
		const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
			code: 'P2002',
			clientVersion: 'test',
		});
		mockCreate.mockRejectedValue(p2002);
		mockFindUnique.mockResolvedValue({
			digest: 'abc',
			validUntil: new Date(Date.now() + 60_000),
		});
		await expect(
			markRevealSignatureUsed({
				signature: 'sig',
				key: 'key',
				blockchainIdentifier: 'chain',
				validUntil: Date.now() + 60_000,
			}),
		).resolves.toEqual({ status: 'idempotent' });
	});

	it('rejects replay when prior usage expired', async () => {
		const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
			code: 'P2002',
			clientVersion: 'test',
		});
		mockCreate.mockRejectedValue(p2002);
		mockFindUnique.mockResolvedValue({
			digest: 'abc',
			validUntil: new Date(Date.now() - 1),
		});
		await expect(
			markRevealSignatureUsed({
				signature: 'sig',
				key: 'key',
				blockchainIdentifier: 'chain',
				validUntil: Date.now() + 60_000,
			}),
		).resolves.toEqual({ status: 'rejected' });
	});

	it('prunes rows past validUntil', async () => {
		await expect(pruneExpiredRevealSignatureUsage()).resolves.toBe(3);
	});
});
