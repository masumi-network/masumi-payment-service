import { expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { defaultEndpointsFactory, Middleware, testEndpoint } from 'express-zod-api';
import { z } from '@masumi/payment-core/zod';
import { Network } from '@/generated/prisma/client';
import { fetchAndProcessInBatches } from '@/utils/earnings-helpers';
import { createConcurrencyLimit, concurrencyResponseMiddleware } from './index';

it('keeps the slot until disconnected aggregation work finishes', async () => {
	let releaseWork!: () => void;
	const workGate = new Promise<void>((resolve) => {
		releaseWork = resolve;
	});
	let notifyFirst!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		notifyFirst = resolve;
	});
	let notifySecond!: () => void;
	const secondStarted = new Promise<void>((resolve) => {
		notifySecond = resolve;
	});
	const responses: Response[] = [];
	let running = 0;
	let peakRunning = 0;
	let finishedPages = 0;
	const withLimit = createConcurrencyLimit({ limit: 1, timeoutMs: 60_000 });
	const endpoint = defaultEndpointsFactory
		.addMiddleware(concurrencyResponseMiddleware)
		.addMiddleware(
			new Middleware({
				input: z.object({}),
				handler: async () => ({
					id: 'review-key',
					canRead: true,
					canPay: false,
					canAdmin: false,
					networkLimit: [Network.Preprod],
					caip2NetworkLimit: ['cardano:preprod'],
					usageLimited: false,
					walletScopeIds: null,
					x402WalletScopeIds: null,
				}),
			}),
		)
		.addMiddleware(
			new Middleware({
				input: z.object({}),
				handler: async ({ response }) => {
					responses.push(response);
					return {};
				},
			}),
		)
		.build({
			method: 'post',
			input: z.object({}),
			output: z.object({}),
			handler: withLimit(async (_, signal) => {
				running += 1;
				peakRunning = Math.max(peakRunning, running);
				if (responses.length === 1) notifyFirst();
				else notifySecond();
				let page = 0;
				await fetchAndProcessInBatches(
					async () => {
						await workGate;
						return page++ < 2 ? [{ id: String(page) }] : [];
					},
					1,
					() => {
						finishedPages += 1;
					},
					signal,
				);
				running -= 1;
				return {};
			}),
		});
	const invoke = () =>
		testEndpoint({
			endpoint,
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
	const first = invoke();
	await Promise.race([
		firstStarted,
		first.then(() => {
			throw new Error('Handler did not start');
		}),
	]);
	responses[0].emit('close');
	const second = invoke();
	await Promise.race([secondStarted, second]);
	releaseWork();
	const results = await Promise.all([first, second]);
	expect(results.map(({ responseMock }) => responseMock.statusCode)).toEqual([499, 503]);
	expect(finishedPages).toBe(0);
	expect(peakRunning).toBeLessThanOrEqual(1);
});
