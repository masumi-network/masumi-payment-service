import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { testMiddleware } from 'express-zod-api';
import { Network } from '@/generated/prisma/client';
import type { AuthContext } from '@masumi/payment-core/auth-middleware';
import { createConcurrencyLimitMiddleware } from './index';

const makeAuthContext = (overrides: Partial<AuthContext> = {}): AuthContext => ({
	id: 'api-key-default',
	canRead: true,
	canPay: true,
	canAdmin: false,
	networkLimit: [Network.Mainnet, Network.Preprod],
	caip2NetworkLimit: ['cardano:mainnet', 'cardano:preprod'],
	usageLimited: false,
	walletScopeIds: null,
	x402WalletScopeIds: null,
	...overrides,
});

describe('createConcurrencyLimitMiddleware', () => {
	it('caps combined concurrency across different API keys and rejects with 503', async () => {
		const middleware = createConcurrencyLimitMiddleware({ limit: 2, timeoutMs: 60_000 });

		const active = await Promise.all([
			testMiddleware({
				middleware,
				ctx: makeAuthContext({ id: 'api-key-a' }),
				requestProps: { method: 'POST', body: {} },
				responseOptions: { eventEmitter: EventEmitter },
			}),
			testMiddleware({
				middleware,
				ctx: makeAuthContext({ id: 'api-key-b' }),
				requestProps: { method: 'POST', body: {} },
				responseOptions: { eventEmitter: EventEmitter },
			}),
		]);
		expect(active.map(({ responseMock }) => responseMock.statusCode)).toEqual([200, 200]);

		const blocked = await testMiddleware({
			middleware,
			ctx: makeAuthContext({ id: 'api-key-c' }),
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		expect(blocked.responseMock.statusCode).toBe(503);
		expect(blocked.responseMock.getHeader('retry-after')).toBe('1');

		for (const { responseMock } of active) responseMock.emit('finish');
	});

	it('releases a slot when the response finishes, admitting the next request', async () => {
		const middleware = createConcurrencyLimitMiddleware({ limit: 1, timeoutMs: 60_000 });

		const first = await testMiddleware({
			middleware,
			ctx: makeAuthContext(),
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		expect(first.responseMock.statusCode).toBe(200);

		const blocked = await testMiddleware({
			middleware,
			ctx: makeAuthContext(),
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		expect(blocked.responseMock.statusCode).toBe(503);

		first.responseMock.emit('finish');

		const admitted = await testMiddleware({
			middleware,
			ctx: makeAuthContext(),
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		expect(admitted.responseMock.statusCode).toBe(200);
		admitted.responseMock.emit('finish');
	});

	it('releases a slot when the response closes early', async () => {
		const middleware = createConcurrencyLimitMiddleware({ limit: 1, timeoutMs: 60_000 });

		const first = await testMiddleware({
			middleware,
			ctx: makeAuthContext(),
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		first.responseMock.emit('close');

		const admitted = await testMiddleware({
			middleware,
			ctx: makeAuthContext(),
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		expect(admitted.responseMock.statusCode).toBe(200);
		admitted.responseMock.emit('finish');
	});

	it('expires a slot that never finishes or closes, so a hung handler cannot leak it forever', async () => {
		jest.useFakeTimers();
		try {
			const middleware = createConcurrencyLimitMiddleware({ limit: 1, timeoutMs: 60_000 });

			const stalled = await testMiddleware({
				middleware,
				ctx: makeAuthContext(),
				requestProps: { method: 'POST', body: {} },
				responseOptions: { eventEmitter: EventEmitter },
			});
			expect(stalled.responseMock.statusCode).toBe(200);

			await jest.advanceTimersByTimeAsync(60_000);

			const admitted = await testMiddleware({
				middleware,
				ctx: makeAuthContext(),
				requestProps: { method: 'POST', body: {} },
				responseOptions: { eventEmitter: EventEmitter },
			});
			expect(admitted.responseMock.statusCode).toBe(200);
			admitted.responseMock.emit('finish');
		} finally {
			jest.useRealTimers();
		}
	});

	it('destroys the response when the timeout fires, so a stuck connection is not held open forever', async () => {
		jest.useFakeTimers();
		try {
			const middleware = createConcurrencyLimitMiddleware({ limit: 1, timeoutMs: 60_000 });

			const stalled = await testMiddleware({
				middleware,
				ctx: makeAuthContext(),
				requestProps: { method: 'POST', body: {} },
				responseOptions: { eventEmitter: EventEmitter },
			});
			const destroySpy = jest.spyOn(stalled.responseMock, 'destroy');

			await jest.advanceTimersByTimeAsync(60_000);

			expect(destroySpy).toHaveBeenCalledTimes(1);
		} finally {
			jest.useRealTimers();
		}
	});
});
