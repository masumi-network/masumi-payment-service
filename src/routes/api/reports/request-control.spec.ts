import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Network } from '@/generated/prisma/client';
import { defaultEndpointsFactory, Middleware, testEndpoint, testMiddleware } from 'express-zod-api';
import {
	privateReportResponseMiddleware,
	reportAbortMiddleware,
	reportConcurrencyMiddleware,
	REPORT_CONCURRENCY_LIMIT,
	REPORT_RESPONSE_TIMEOUT_MS,
} from './request-control';

const authContext: AuthContext = {
	id: 'api-key-1',
	canRead: true,
	canPay: false,
	canAdmin: false,
	networkLimit: [Network.Preprod],
	caip2NetworkLimit: [],
	usageLimited: false,
	walletScopeIds: null,
	x402WalletScopeIds: null,
};

describe('report request control', () => {
	it('preserves existing Vary fields when it adds the token field', async () => {
		const existingVaryMiddleware = new Middleware<Record<string, never>, AuthContext, string>({
			handler: async ({ response }) => {
				response.setHeader('Vary', 'Origin');
				return authContext;
			},
		});
		const endpoint = defaultEndpointsFactory
			.addMiddleware(existingVaryMiddleware)
			.addMiddleware(privateReportResponseMiddleware)
			.build({
				method: 'get',
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => ({ ok: true }),
			});

		const { responseMock } = await testEndpoint({
			endpoint,
			requestProps: { method: 'GET' },
		});

		expect(responseMock.getHeader('vary')).toBe('Origin, token');
	});

	it('aborts report work when the request is aborted', async () => {
		const { output, requestMock } = await testMiddleware({
			middleware: reportAbortMiddleware,
			ctx: authContext,
			requestProps: { method: 'POST', body: {} },
		});
		const signal = output.reportAbortSignal as AbortSignal;

		expect(signal.aborted).toBe(false);
		requestMock.emit('aborted');
		expect(signal.aborted).toBe(true);
	});

	it('does not abort completed report work when the response closes normally', async () => {
		const { output, responseMock } = await testMiddleware({
			middleware: reportAbortMiddleware,
			ctx: authContext,
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		const signal = output.reportAbortSignal as AbortSignal;
		Object.defineProperty(responseMock, 'writableEnded', { configurable: true, value: true });

		responseMock.emit('close');
		expect(signal.aborted).toBe(false);
	});

	it('aborts unfinished report work when the response closes early', async () => {
		const { output, responseMock } = await testMiddleware({
			middleware: reportAbortMiddleware,
			ctx: authContext,
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		const signal = output.reportAbortSignal as AbortSignal;

		responseMock.emit('close');
		expect(signal.aborted).toBe(true);
	});

	it('caps concurrent reports for admin API keys and releases completed slots', async () => {
		const adminContext = { ...authContext, canAdmin: true };
		const active = await Promise.all(
			Array.from({ length: 4 }, () =>
				testMiddleware({
					middleware: reportConcurrencyMiddleware,
					ctx: adminContext,
					requestProps: { method: 'POST', body: {} },
					responseOptions: { eventEmitter: EventEmitter },
				}),
			),
		);
		expect(active.map(({ responseMock }) => responseMock.statusCode)).toEqual([200, 200, 200, 200]);

		const blocked = await testMiddleware({
			middleware: reportConcurrencyMiddleware,
			ctx: adminContext,
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		expect(blocked.responseMock.statusCode).toBe(503);
		expect(blocked.responseMock.getHeader('retry-after')).toBe('1');

		type RunReportOperation = <T>(
			operation: (trackPendingWork: (work: Promise<unknown>) => void) => Promise<T>,
		) => Promise<T>;
		const runReportOperation = active[0].output.runReportOperation as RunReportOperation | undefined;
		if (runReportOperation == null) {
			for (const { responseMock } of active) responseMock.emit('finish');
		}
		expect(runReportOperation).toEqual(expect.any(Function));
		let resolvePendingWork!: () => void;
		const pendingWork = new Promise<void>((resolve) => {
			resolvePendingWork = resolve;
		});
		const responseOperation = runReportOperation?.(async (trackPendingWork) => {
			trackPendingWork(pendingWork);
			throw new Error('Report response deadline reached');
		});
		active[0].responseMock.emit('close');
		await expect(responseOperation).rejects.toThrow('Report response deadline reached');

		const blockedAfterClose = await testMiddleware({
			middleware: reportConcurrencyMiddleware,
			ctx: adminContext,
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		expect(blockedAfterClose.responseMock.statusCode).toBe(503);

		resolvePendingWork();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const admitted = await testMiddleware({
			middleware: reportConcurrencyMiddleware,
			ctx: adminContext,
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		expect(admitted.responseMock.statusCode).toBe(200);

		for (const { responseMock } of active.slice(1)) responseMock.emit('finish');
		admitted.responseMock.emit('finish');
	});

	it('holds resolved report slots until their responses finish', async () => {
		const active = await Promise.all(
			Array.from({ length: 4 }, () =>
				testMiddleware({
					middleware: reportConcurrencyMiddleware,
					ctx: authContext,
					requestProps: { method: 'POST', body: {} },
					responseOptions: { eventEmitter: EventEmitter },
				}),
			),
		);
		await Promise.all(
			active.map(({ output }) => {
				const runReportOperation = output.runReportOperation as
					| ((operation: () => Promise<string>) => Promise<string>)
					| undefined;
				return runReportOperation?.(async () => 'staged-artifact');
			}),
		);

		const blocked = await testMiddleware({
			middleware: reportConcurrencyMiddleware,
			ctx: authContext,
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		expect(blocked.responseMock.statusCode).toBe(503);

		active[0].responseMock.emit('finish');
		const admitted = await testMiddleware({
			middleware: reportConcurrencyMiddleware,
			ctx: authContext,
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		expect(admitted.responseMock.statusCode).toBe(200);

		for (const { responseMock } of active.slice(1)) responseMock.emit('finish');
		admitted.responseMock.emit('finish');
	});

	it('expires unfinished responses and releases their report slots', async () => {
		jest.useFakeTimers();
		const active = await Promise.all(
			Array.from({ length: 4 }, () =>
				testMiddleware({
					middleware: reportConcurrencyMiddleware,
					ctx: authContext,
					requestProps: { method: 'POST', body: {} },
					responseOptions: { eventEmitter: EventEmitter },
				}),
			),
		);
		try {
			const destroySpies = active.map(({ responseMock }) => jest.spyOn(responseMock, 'destroy'));
			await Promise.all(
				active.map(({ output }) => {
					const runReportOperation = output.runReportOperation as
						| ((operation: () => Promise<string>) => Promise<string>)
						| undefined;
					return runReportOperation?.(async () => 'staged-artifact');
				}),
			);

			await jest.advanceTimersByTimeAsync(REPORT_RESPONSE_TIMEOUT_MS);
			expect(destroySpies.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);

			const admitted = await testMiddleware({
				middleware: reportConcurrencyMiddleware,
				ctx: authContext,
				requestProps: { method: 'POST', body: {} },
				responseOptions: { eventEmitter: EventEmitter },
			});
			expect(admitted.responseMock.statusCode).toBe(200);
			admitted.responseMock.emit('finish');
		} finally {
			for (const { responseMock } of active) responseMock.emit('finish');
			jest.useRealTimers();
		}
	});

	/**
	 * A client that disconnects before the handler starts releases the slot, and
	 * the handler then takes it back. That second acquisition used to inherit no
	 * timer and no response listeners, because releasing had removed both, so an
	 * operation that never settled kept the slot for the lifetime of the process.
	 */
	it('re-arms the deadline when a released slot is taken back', async () => {
		jest.useFakeTimers();
		const stalled = await testMiddleware({
			middleware: reportConcurrencyMiddleware,
			ctx: authContext,
			requestProps: { method: 'POST', body: {} },
			responseOptions: { eventEmitter: EventEmitter },
		});
		try {
			// The client goes away before the handler runs, which frees the slot.
			stalled.responseMock.emit('close');

			const runReportOperation = stalled.output.runReportOperation as (
				operation: () => Promise<string>,
			) => Promise<string>;
			// The handler takes the slot back, then never settles.
			void runReportOperation(() => new Promise<string>(() => {}));
			await Promise.resolve();

			// Only the re-armed deadline can free this slot now.
			await jest.advanceTimersByTimeAsync(REPORT_RESPONSE_TIMEOUT_MS);

			// Every slot must be available again. Without the re-armed deadline the
			// stalled request still holds one and the last of these is refused.
			const admitted = [];
			for (let index = 0; index < REPORT_CONCURRENCY_LIMIT; index += 1) {
				admitted.push(
					await testMiddleware({
						middleware: reportConcurrencyMiddleware,
						ctx: authContext,
						requestProps: { method: 'POST', body: {} },
						responseOptions: { eventEmitter: EventEmitter },
					}),
				);
			}
			expect(admitted.map(({ responseMock }) => responseMock.statusCode)).toEqual(
				Array.from({ length: REPORT_CONCURRENCY_LIMIT }, () => 200),
			);
			for (const { responseMock } of admitted) responseMock.emit('finish');
		} finally {
			jest.useRealTimers();
		}
	});
});
