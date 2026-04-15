import { describe, expect, it } from '@jest/globals';
import { testMiddleware } from 'express-zod-api';
import { Network } from '@/generated/prisma/client';
import type { AuthContext } from '@/utils/middleware/auth-middleware';
import { createAuthenticatedRateLimitMiddleware } from './index';

const makeAuthContext = (overrides: Partial<AuthContext> = {}): AuthContext => ({
	id: 'api-key-default',
	canRead: true,
	canPay: true,
	canAdmin: false,
	networkLimit: [Network.Mainnet, Network.Preprod],
	usageLimited: false,
	walletScopeIds: null,
	...overrides,
});

describe('createAuthenticatedRateLimitMiddleware', () => {
	it('tracks rate limits independently per API key', async () => {
		const middleware = createAuthenticatedRateLimitMiddleware({
			maxRequests: 1,
			windowMs: 60_000,
		});

		const first = await testMiddleware({
			middleware,
			ctx: makeAuthContext({ id: 'api-key-a' }),
			requestProps: { method: 'POST', body: {}, ip: '198.51.100.10' },
		});
		expect(first.responseMock.statusCode).toBe(200);

		const otherKey = await testMiddleware({
			middleware,
			ctx: makeAuthContext({ id: 'api-key-b' }),
			requestProps: { method: 'POST', body: {}, ip: '198.51.100.10' },
		});
		expect(otherKey.responseMock.statusCode).toBe(200);
	});

	it('rejects only the API key that exceeded its limit', async () => {
		const middleware = createAuthenticatedRateLimitMiddleware({
			maxRequests: 1,
			windowMs: 60_000,
		});

		const first = await testMiddleware({
			middleware,
			ctx: makeAuthContext({ id: 'api-key-a' }),
			requestProps: { method: 'POST', body: {}, ip: '198.51.100.20' },
		});
		expect(first.responseMock.statusCode).toBe(200);

		const blocked = await testMiddleware({
			middleware,
			ctx: makeAuthContext({ id: 'api-key-a' }),
			requestProps: { method: 'POST', body: {}, ip: '198.51.100.21' },
		});
		expect(blocked.responseMock.statusCode).toBe(429);

		const otherKey = await testMiddleware({
			middleware,
			ctx: makeAuthContext({ id: 'api-key-b' }),
			requestProps: { method: 'POST', body: {}, ip: '198.51.100.21' },
		});
		expect(otherKey.responseMock.statusCode).toBe(200);
	});

	it('bypasses rate limits for admin keys', async () => {
		const middleware = createAuthenticatedRateLimitMiddleware({
			maxRequests: 1,
			windowMs: 60_000,
		});

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const result = await testMiddleware({
				middleware,
				ctx: makeAuthContext({ id: 'admin-key', canAdmin: true }),
				requestProps: { method: 'POST', body: {}, ip: '198.51.100.30' },
			});

			expect(result.responseMock.statusCode).toBe(200);
		}
	});
});
