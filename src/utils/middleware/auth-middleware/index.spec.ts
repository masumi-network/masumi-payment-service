import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testMiddleware } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: { ENCRYPTION_KEY: '12345678901234567890' },
	DEFAULTS: { DEFAULT_ADMIN_KEY: 'default-admin-key' },
	CONSTANTS: { TRANSACTION_WAIT: { SERIALIZABLE: 5000 } },
}));

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		apiKey: {
			findUnique: jest.fn(),
		},
	},
}));

const { authMiddleware } = await import('./index');
const { prisma } = await import('@/utils/db');
const { generateApiKeySecureHash } = await import('@/utils/crypto/api-key-hash');
const mockFindUnique = prisma.apiKey.findUnique as AnyMock;

/** Build a minimal valid active API key DB row */
function makeApiKey(overrides: Record<string, unknown> = {}) {
	return {
		id: 'key-id-1',
		status: ApiKeyStatus.Active,
		canRead: true,
		canPay: false,
		canAdmin: false,
		usageLimited: false,
		networkLimit: [Network.Mainnet, Network.Preprod],
		walletScopeEnabled: false,
		WalletScopes: [],
		tokenHash: null,
		token: null,
		tokenHashSecure: 'pbkdf2-placeholder',
		encryptedToken: 'some-encrypted-value',
		...overrides,
	};
}

describe('authMiddleware', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	// -------------------------------------------------------------------------
	// Token presence checks
	// -------------------------------------------------------------------------

	it('should resolve successfully if valid token provided', async () => {
		mockFindUnique.mockResolvedValue(makeApiKey({ canAdmin: true }));

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(200);
	});

	it('should throw 401 if no token provided (read)', async () => {
		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: {} },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if no token provided (pay)', async () => {
		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: {} },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if no token provided (admin)', async () => {
		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: {} },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if empty string token sent', async () => {
		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: '' } },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	// -------------------------------------------------------------------------
	// DB lookup — uses tokenHash
	// -------------------------------------------------------------------------

	it('looks up the API key by tokenHash', async () => {
		mockFindUnique.mockResolvedValue(makeApiKey());

		await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		// Extract the first call's first argument (the Prisma query object)
		const firstCallArgs = mockFindUnique.mock.calls[0] as [{ where: Record<string, unknown> }];
		const queryArg = firstCallArgs[0];
		expect(queryArg.where).toHaveProperty('tokenHash');
		expect(queryArg.where).not.toHaveProperty('token');
	});

	it('computes the tokenHash from the incoming token header value', async () => {
		const sentToken = 'masumi-payment-admin-testtoken';
		const expectedHash = await generateApiKeySecureHash(sentToken);

		mockFindUnique.mockResolvedValue(makeApiKey({ canAdmin: true }));

		await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: sentToken } },
		});

		const firstCallArgs = mockFindUnique.mock.calls[0] as [{ where: Record<string, unknown> }];
		const queryArg = firstCallArgs[0];
		expect(queryArg.where).toEqual({ tokenHash: expectedHash });
	});

	// -------------------------------------------------------------------------
	// Invalid / non-existent token
	// -------------------------------------------------------------------------

	it('should throw 401 if token does not match any DB record (read)', async () => {
		mockFindUnique.mockResolvedValue(null);

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'does-not-exist' } },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if token does not match any DB record (pay)', async () => {
		mockFindUnique.mockResolvedValue(null);

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'does-not-exist' } },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if token does not match any DB record (admin)', async () => {
		mockFindUnique.mockResolvedValue(null);

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'does-not-exist' } },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	// -------------------------------------------------------------------------
	// Revoked key
	// -------------------------------------------------------------------------

	it('should throw 401 if token is revoked', async () => {
		mockFindUnique.mockResolvedValue(makeApiKey({ status: ApiKeyStatus.Revoked, canAdmin: true }));

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	// -------------------------------------------------------------------------
	// Permission checks
	// -------------------------------------------------------------------------

	it('should throw 401 if pay required but key is read-only', async () => {
		mockFindUnique.mockResolvedValue(makeApiKey({ canRead: true, canPay: false, canAdmin: false }));

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if admin required but key has only pay permission', async () => {
		mockFindUnique.mockResolvedValue(makeApiKey({ canRead: true, canPay: true, canAdmin: false }));

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if admin required but key is read-only', async () => {
		mockFindUnique.mockResolvedValue(makeApiKey({ canRead: true, canPay: false, canAdmin: false }));

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(401);
	});

	// -------------------------------------------------------------------------
	// Successful lookups — output shape
	// -------------------------------------------------------------------------

	it('should pass validation with a read-only key', async () => {
		const mockKey = makeApiKey({ canRead: true, canPay: false, canAdmin: false, usageLimited: true, networkLimit: [] });
		mockFindUnique.mockResolvedValue(mockKey);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(output).toEqual({
			id: mockKey.id,
			canRead: true,
			canPay: false,
			canAdmin: false,
			usageLimited: true,
			networkLimit: [],
			walletScopeIds: null,
		});
	});

	it('should pass validation with a pay key', async () => {
		const mockKey = makeApiKey({ canRead: true, canPay: true, canAdmin: false, usageLimited: true, networkLimit: [] });
		mockFindUnique.mockResolvedValue(mockKey);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(output).toEqual({
			id: mockKey.id,
			canRead: true,
			canPay: true,
			canAdmin: false,
			usageLimited: true,
			networkLimit: [],
			walletScopeIds: null,
		});
	});

	it('should pass validation with an admin key', async () => {
		const mockKey = makeApiKey({ canRead: true, canPay: true, canAdmin: true, usageLimited: false, networkLimit: [] });
		mockFindUnique.mockResolvedValue(mockKey);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		// Admin gets all networks and usageLimited forced to false
		expect(output).toEqual({
			id: mockKey.id,
			canRead: true,
			canPay: true,
			canAdmin: true,
			usageLimited: false,
			networkLimit: [Network.Mainnet, Network.Preprod],
			walletScopeIds: null,
		});
	});

	it('admin bypasses network restrictions (always gets all networks)', async () => {
		// Even if networkLimit is empty on the DB row, admin gets both networks
		const mockKey = makeApiKey({ canAdmin: true, networkLimit: [] });
		mockFindUnique.mockResolvedValue(mockKey);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect((output as { networkLimit: Network[] }).networkLimit).toEqual([Network.Mainnet, Network.Preprod]);
	});

	it('admin bypasses usage limits (usageLimited forced to false)', async () => {
		// Even if usageLimited=true on DB row, admin gets false
		const mockKey = makeApiKey({ canAdmin: true, usageLimited: true });
		mockFindUnique.mockResolvedValue(mockKey);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect((output as { usageLimited: boolean }).usageLimited).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Wallet scope
	// -------------------------------------------------------------------------

	it('returns null walletScopeIds when walletScopeEnabled is false', async () => {
		mockFindUnique.mockResolvedValue(
			makeApiKey({
				walletScopeEnabled: false,
				WalletScopes: [{ hotWalletId: 'wallet-a' }],
			}),
		);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect((output as { walletScopeIds: null }).walletScopeIds).toBeNull();
	});

	it('returns walletScopeIds when walletScopeEnabled is true and key is not admin', async () => {
		mockFindUnique.mockResolvedValue(
			makeApiKey({
				canAdmin: false,
				walletScopeEnabled: true,
				WalletScopes: [{ hotWalletId: 'wallet-a' }, { hotWalletId: 'wallet-b' }],
			}),
		);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect((output as { walletScopeIds: string[] }).walletScopeIds).toEqual(['wallet-a', 'wallet-b']);
	});

	it('admin always gets null walletScopeIds even if walletScopeEnabled is true', async () => {
		mockFindUnique.mockResolvedValue(
			makeApiKey({
				canAdmin: true,
				walletScopeEnabled: true,
				WalletScopes: [{ hotWalletId: 'wallet-a' }],
			}),
		);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect((output as { walletScopeIds: null }).walletScopeIds).toBeNull();
	});

	// -------------------------------------------------------------------------
	// Permission hierarchy
	// -------------------------------------------------------------------------

	it('admin can access read endpoints', async () => {
		mockFindUnique.mockResolvedValue(makeApiKey({ canRead: true, canPay: true, canAdmin: true }));

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(200);
	});

	it('admin can access pay endpoints', async () => {
		mockFindUnique.mockResolvedValue(makeApiKey({ canRead: true, canPay: true, canAdmin: true }));

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(200);
	});

	it('pay key can access read endpoints', async () => {
		mockFindUnique.mockResolvedValue(makeApiKey({ canRead: true, canPay: true, canAdmin: false }));

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(200);
	});

	it('network-limited key respects its allowed networks', async () => {
		mockFindUnique.mockResolvedValue(makeApiKey({ canPay: true, networkLimit: [Network.Preprod, Network.Mainnet] }));

		const { responseMock, output } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(200);
		expect((output as { networkLimit: Network[] }).networkLimit).toEqual([Network.Preprod, Network.Mainnet]);
	});
});
