import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Middleware, testMiddleware } from 'express-zod-api';
import createHttpError from 'http-errors';
import { createConcurrencyLimit } from './index';

const makeResponse = async () => {
	const { responseMock } = await testMiddleware({
		middleware: new Middleware({ handler: async () => ({}) }),
		responseOptions: { eventEmitter: EventEmitter },
	});
	return responseMock;
};

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

// Invariant: a slot remains occupied until its handler settles, even after cancellation.
describe('createConcurrencyLimit', () => {
	it('shares capacity across handlers and admits new work after completion', async () => {
		const withLimit = createConcurrencyLimit({ limit: 1, timeoutMs: 60_000 });
		const gate = deferred();
		const firstResponse = await makeResponse();
		const secondResponse = await makeResponse();
		const first = withLimit(async () => {
			await gate.promise;
			return 'first';
		});
		const secondHandler = jest.fn(async () => 'second');
		const second = withLimit(secondHandler);
		const running = first({ ctx: { concurrencyResponse: firstResponse } });
		await expect(second({ ctx: { concurrencyResponse: secondResponse } })).rejects.toMatchObject({ statusCode: 503 });
		expect(secondResponse.getHeader('retry-after')).toBe('1');
		expect(secondHandler).not.toHaveBeenCalled();
		gate.resolve();
		await expect(running).resolves.toBe('first');
		await expect(second({ ctx: { concurrencyResponse: secondResponse } })).resolves.toBe('second');
		expect(firstResponse.listenerCount('close')).toBe(0);
	});

	it('holds the slot after disconnect until the handler settles', async () => {
		const withLimit = createConcurrencyLimit({ limit: 1, timeoutMs: 60_000 });
		const gate = deferred();
		const response = await makeResponse();
		let signal!: AbortSignal;
		const handler = withLimit(async (_, currentSignal) => {
			signal = currentSignal;
			await gate.promise;
		});
		const running = handler({ ctx: { concurrencyResponse: response } });
		response.emit('close');
		expect(signal.aborted).toBe(true);
		await expect(handler({ ctx: { concurrencyResponse: await makeResponse() } })).rejects.toMatchObject({
			statusCode: 503,
		});
		gate.resolve();
		await running;
		await expect(handler({ ctx: { concurrencyResponse: await makeResponse() } })).resolves.toBeUndefined();
	});

	it('holds the slot after timeout while work is still in flight', async () => {
		jest.useFakeTimers();
		try {
			const withLimit = createConcurrencyLimit({ limit: 1, timeoutMs: 60_000 });
			const gate = deferred();
			const response = await makeResponse();
			const destroy = jest.spyOn(response, 'destroy');
			let signal!: AbortSignal;
			const handler = withLimit(async (_, currentSignal) => {
				signal = currentSignal;
				await gate.promise;
			});
			const running = handler({ ctx: { concurrencyResponse: response } });
			await jest.advanceTimersByTimeAsync(60_000);
			expect(destroy).toHaveBeenCalledTimes(1);
			expect(signal.aborted).toBe(true);
			await expect(handler({ ctx: { concurrencyResponse: await makeResponse() } })).rejects.toMatchObject({
				statusCode: 503,
			});
			gate.resolve();
			await running;
			await expect(handler({ ctx: { concurrencyResponse: await makeResponse() } })).resolves.toBeUndefined();
			expect(jest.getTimerCount()).toBe(0);
		} finally {
			jest.useRealTimers();
		}
	});

	it('releases capacity and cleans up after handler errors', async () => {
		jest.useFakeTimers();
		try {
			const withLimit = createConcurrencyLimit({ limit: 1, timeoutMs: 60_000 });
			const response = await makeResponse();
			const handler = withLimit(async () => {
				throw createHttpError(500, 'Query failed');
			});
			await expect(handler({ ctx: { concurrencyResponse: response } })).rejects.toThrow('Query failed');
			expect(response.listenerCount('close')).toBe(0);
			expect(jest.getTimerCount()).toBe(0);
			await expect(withLimit(async () => 'ok')({ ctx: { concurrencyResponse: response } })).resolves.toBe('ok');
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not start work when the response is already destroyed', async () => {
		const response = await makeResponse();
		Object.defineProperty(response, 'destroyed', { value: true });
		const handler = jest.fn(async () => 'ok');
		const run = createConcurrencyLimit({ limit: 1, timeoutMs: 60_000 })(handler);
		await expect(run({ ctx: { concurrencyResponse: response } })).rejects.toMatchObject({ statusCode: 499 });
		expect(handler).not.toHaveBeenCalled();
		await expect(run({ ctx: { concurrencyResponse: await makeResponse() } })).resolves.toBe('ok');
	});
});
