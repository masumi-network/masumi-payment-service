import { expect, it } from '@jest/globals';
import { EventEmitter, once } from 'node:events';
import { createConfig, createServer, defaultEndpointsFactory, Middleware, testMiddleware } from 'express-zod-api';
import { z } from '@masumi/payment-core/zod';
import { CORS_EXPOSED_HEADERS_VALUE } from '@/utils/cors-headers';
import { createConcurrencyLimit, concurrencyResponseMiddleware } from './index';

it('returns readable overload responses while preflight and health remain available', async () => {
	let releaseWork!: () => void;
	const work = new Promise<void>((resolve) => {
		releaseWork = resolve;
	});
	let notifyStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		notifyStarted = resolve;
	});
	const withLimit = createConcurrencyLimit({ limit: 1, timeoutMs: 60_000 });
	const earnings = defaultEndpointsFactory.addMiddleware(concurrencyResponseMiddleware).build({
		method: 'post',
		input: z.object({}),
		output: z.object({}),
		handler: withLimit(async () => {
			notifyStarted();
			await work;
			return {};
		}),
	});
	const health = defaultEndpointsFactory.build({
		method: 'get',
		output: z.object({ status: z.string() }),
		handler: async () => ({ status: 'ok' }),
	});
	const { app } = await createServer(
		createConfig({
			startupLogo: false,
			cors: ({ defaultHeaders }) => ({
				...defaultHeaders,
				'Access-Control-Expose-Headers': CORS_EXPOSED_HEADERS_VALUE,
			}),
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		}),
		{ earnings, health },
	);
	const invoke = async (method: 'POST' | 'OPTIONS' | 'GET', url: string) => {
		const { requestMock, responseMock } = await testMiddleware({
			middleware: new Middleware({ handler: async () => ({}) }),
			requestProps: { method, url, headers: { origin: 'https://example.com' } },
			responseOptions: { eventEmitter: EventEmitter },
		});
		const complete = once(responseMock, 'end');
		app(requestMock, responseMock);
		await complete;
		return responseMock;
	};
	const active = invoke('POST', '/earnings');
	try {
		await started;
		const blocked = await invoke('POST', '/earnings');
		expect(blocked.statusCode).toBe(503);
		expect(blocked.getHeader('access-control-allow-origin')).toBe('*');
		expect(blocked.getHeader('access-control-expose-headers')).toContain('Retry-After');
		expect(blocked.getHeader('retry-after')).toBe('1');
		expect((await invoke('OPTIONS', '/earnings')).statusCode).toBe(200);
		expect((await invoke('GET', '/health'))._getJSONData().data).toEqual({ status: 'ok' });
	} finally {
		releaseWork();
		await active;
	}
});
