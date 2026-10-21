import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const PUBLIC_ENCRYPTION_KEY = '12345678901234567890123456789012';
// CONFIG reads the key once, when the dynamic imports below first load it.
process.env.ENCRYPTION_KEY = PUBLIC_ENCRYPTION_KEY;

const mockFindApiKey = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { apiKey: { findUnique: mockFindApiKey } },
}));

const { securityStatusGet } = await import('./index');
const { usesPublicEncryptionKey } = await import('@/utils/security/public-encryption-key');

function apiKey(canAdmin: boolean) {
	return {
		id: 'api-key-1',
		canRead: true,
		canPay: canAdmin,
		canAdmin,
		status: ApiKeyStatus.Active,
		token: null,
		tokenHash: null,
		tokenHashSecure: 'pbkdf2-placeholder',
		usageLimited: false,
		networkLimit: [Network.Preprod],
		walletScopeEnabled: false,
		WalletScopes: [],
	};
}

async function getSecurityStatus() {
	return testEndpoint({
		endpoint: securityStatusGet,
		requestProps: { method: 'GET', headers: { token: 'valid' } },
	});
}

describe('usesPublicEncryptionKey', () => {
	it('matches the .env.example value, also as docker run --env-file passes it', () => {
		expect(usesPublicEncryptionKey(PUBLIC_ENCRYPTION_KEY)).toBe(true);
		expect(usesPublicEncryptionKey(` ${PUBLIC_ENCRYPTION_KEY}\n`)).toBe(true);
		// Docker keeps the quotes and the inline comment of the .env.example line.
		expect(usesPublicEncryptionKey(`"${PUBLIC_ENCRYPTION_KEY}" #This is a secret key`)).toBe(true);
		expect(usesPublicEncryptionKey('a-private-key-of-at-least-32-characters')).toBe(false);
	});
});

describe('GET /security-status', () => {
	it('reports the public key to an admin key', async () => {
		mockFindApiKey.mockResolvedValue(apiKey(true));
		const { responseMock } = await getSecurityStatus();
		expect(responseMock.statusCode).toBe(200);
		expect(responseMock._getJSONData()).toMatchObject({ data: { isEncryptionKeyPublic: true } });
	});

	it('hides the key state from a key without admin access', async () => {
		mockFindApiKey.mockResolvedValue(apiKey(false));
		const { responseMock } = await getSecurityStatus();
		expect(responseMock.statusCode).toBe(401);
		const body = JSON.stringify(responseMock._getJSONData());
		expect(body).toContain('admin access required');
		expect(body).not.toContain('isEncryptionKeyPublic');
	});
});
