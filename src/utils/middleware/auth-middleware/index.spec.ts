import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testMiddleware } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';
import { generateSHA256Hash } from '@/utils/crypto';

type AnyMock = Mock<(...args: any[]) => any>;

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		apiKey: {
			findUnique: jest.fn(),
		},
	},
}));

const { authMiddleware } = await import('./index');
const { prisma } = await import('@/utils/db');
const mockFindUnique = prisma.apiKey.findUnique as AnyMock;

describe('authMiddleware', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('should resolve successfully if valid token provided', async () => {
		mockFindUnique.mockResolvedValue({
			id: 1,
			canRead: true,
			canPay: true,
			canAdmin: true,
			status: ApiKeyStatus.Active,
			tokenHash: generateSHA256Hash('valid'),
			token: 'valid',
			usageLimited: true,
			networkLimit: [],
			walletScopeEnabled: false,
			WalletScopes: [],
		});
		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: {
				method: 'POST',
				body: {},
				headers: { token: 'valid' },
			},
		});

		expect(responseMock.statusCode).toBe(200);
	});

	it('should throw 401 if no token provided read', async () => {
		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: {} },
		});

		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if no token provided pay', async () => {
		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: {} },
		});

		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if no token provided admin', async () => {
		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: {} },
		});

		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if invalid token read', async () => {
		mockFindUnique.mockResolvedValue(null);

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: {
				method: 'POST',
				body: {},
				headers: { token: 'invalid' },
			},
		});

		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if invalid token pay', async () => {
		mockFindUnique.mockResolvedValue(null);

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: {
				method: 'POST',
				body: {},
				headers: { token: 'invalid' },
			},
		});

		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if invalid token admin', async () => {
		mockFindUnique.mockResolvedValue(null);

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: {
				method: 'POST',
				body: {},
				headers: { token: 'invalid' },
			},
		});

		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if pay required but user is read only', async () => {
		mockFindUnique.mockResolvedValue({
			id: 1,
			canRead: true,
			canPay: false,
			canAdmin: false,
			status: ApiKeyStatus.Active,
			tokenHash: generateSHA256Hash('valid'),
			token: 'valid',
			usageLimited: true,
			networkLimit: [],
			walletScopeEnabled: false,
			WalletScopes: [],
		});

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if admin required but user is not admin', async () => {
		mockFindUnique.mockResolvedValue({
			id: 1,
			canRead: true,
			canPay: true,
			canAdmin: false,
			status: ApiKeyStatus.Active,
			tokenHash: generateSHA256Hash('valid'),
			token: 'valid',
			usageLimited: true,
			networkLimit: [Network.Preprod],
			walletScopeEnabled: false,
			WalletScopes: [],
		});

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(401);
	});

	it('should throw 401 if token is revoked', async () => {
		mockFindUnique.mockResolvedValue({
			id: 1,
			canRead: true,
			canPay: true,
			canAdmin: true,
			status: ApiKeyStatus.Revoked,
			tokenHash: generateSHA256Hash('valid'),
			token: 'valid',
			usageLimited: true,
			networkLimit: [Network.Preprod],
			walletScopeEnabled: false,
			WalletScopes: [],
		});

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(401);
	});

	it('should pass validation with valid user token', async () => {
		const mockApiKey = {
			id: 1,
			canRead: true,
			canPay: false,
			canAdmin: false,
			status: ApiKeyStatus.Active,
			tokenHash: generateSHA256Hash('valid'),
			token: 'valid',
			usageLimited: true,
			networkLimit: [],
			walletScopeEnabled: false,
			WalletScopes: [],
		};
		mockFindUnique.mockResolvedValue(mockApiKey);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(output).toEqual({
			id: mockApiKey.id,
			canRead: mockApiKey.canRead,
			canPay: mockApiKey.canPay,
			canAdmin: mockApiKey.canAdmin,
			usageLimited: mockApiKey.usageLimited,
			networkLimit: mockApiKey.networkLimit,
			walletScopeIds: null,
		});
	});

	it('should pass validation with valid pay token', async () => {
		const mockApiKey = {
			id: 1,
			canRead: true,
			canPay: true,
			canAdmin: false,
			status: ApiKeyStatus.Active,
			usageLimited: true,
			networkLimit: [],
			walletScopeEnabled: false,
			WalletScopes: [],
		};
		mockFindUnique.mockResolvedValue(mockApiKey);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(output).toEqual({
			id: mockApiKey.id,
			canRead: mockApiKey.canRead,
			canPay: mockApiKey.canPay,
			canAdmin: mockApiKey.canAdmin,
			usageLimited: mockApiKey.usageLimited,
			networkLimit: [],
			walletScopeIds: null,
		});
	});

	it('should pass validation with valid admin token', async () => {
		const mockApiKey = {
			id: 1,
			canRead: true,
			canPay: true,
			canAdmin: true,
			status: ApiKeyStatus.Active,
			usageLimited: false,
			networkLimit: [],
			walletScopeEnabled: false,
			WalletScopes: [],
		};
		mockFindUnique.mockResolvedValue(mockApiKey);

		const { output } = await testMiddleware({
			middleware: authMiddleware({ canAdmin: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(output).toEqual({
			id: mockApiKey.id,
			canRead: mockApiKey.canRead,
			canPay: mockApiKey.canPay,
			canAdmin: mockApiKey.canAdmin,
			networkLimit: [Network.Mainnet, Network.Preprod],
			usageLimited: false,
			walletScopeIds: null,
		});
	});

	it('should pass validation with valid network', async () => {
		const mockApiKey = {
			id: 1,
			canRead: true,
			canPay: true,
			canAdmin: false,
			status: ApiKeyStatus.Active,
			usageLimited: false,
			networkLimit: [Network.Preprod, Network.Mainnet],
			walletScopeEnabled: false,
			WalletScopes: [],
		};
		mockFindUnique.mockResolvedValue(mockApiKey);

		const { output, responseMock } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(200);

		expect(output).toEqual({
			id: mockApiKey.id,
			canRead: mockApiKey.canRead,
			canPay: mockApiKey.canPay,
			canAdmin: mockApiKey.canAdmin,
			networkLimit: mockApiKey.networkLimit,
			usageLimited: mockApiKey.usageLimited,
			walletScopeIds: null,
		});
	});

	// Additional tests for flag-based permission system
	it('should allow admin to access read endpoints', async () => {
		mockFindUnique.mockResolvedValue({
			id: 1,
			canRead: true,
			canPay: true,
			canAdmin: true,
			status: ApiKeyStatus.Active,
			tokenHash: generateSHA256Hash('valid'),
			token: 'valid',
			usageLimited: false,
			networkLimit: [],
		});

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(200);
	});

	it('should allow admin to access pay endpoints', async () => {
		mockFindUnique.mockResolvedValue({
			id: 1,
			canRead: true,
			canPay: true,
			canAdmin: true,
			status: ApiKeyStatus.Active,
			tokenHash: generateSHA256Hash('valid'),
			token: 'valid',
			usageLimited: false,
			networkLimit: [],
		});

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canPay: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(200);
	});

	it('should allow pay user to access read endpoints', async () => {
		mockFindUnique.mockResolvedValue({
			id: 1,
			canRead: true,
			canPay: true,
			canAdmin: false,
			status: ApiKeyStatus.Active,
			tokenHash: generateSHA256Hash('valid'),
			token: 'valid',
			usageLimited: true,
			networkLimit: [Network.Preprod],
		});

		const { responseMock } = await testMiddleware({
			middleware: authMiddleware({ canRead: true }),
			requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(200);
	});
});
