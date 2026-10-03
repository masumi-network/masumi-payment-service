import type { Response } from 'express';
import createHttpError from 'http-errors';
import { Middleware } from 'express-zod-api';

// Endpoint handlers receive HTTP objects through middleware context.
export const concurrencyResponseMiddleware = new Middleware({
	handler: async ({ response }) => ({ concurrencyResponse: response }),
});

type ConcurrencyLimitOptions = {
	limit: number;
	timeoutMs: number;
};

/**
 * Share one wrapper across handlers that use the same resource.
 * Disconnects and timeouts signal cancellation, but the slot stays occupied
 * until the handler settles, including any database query already in flight.
 */
export const createConcurrencyLimit = ({ limit, timeoutMs }: ConcurrencyLimitOptions) => {
	let active = 0;

	return <Args, Result>(handler: (args: Args, signal: AbortSignal) => Promise<Result>) =>
		async (args: Args & { ctx: { concurrencyResponse: Response } }): Promise<Result> => {
			const { concurrencyResponse: response } = args.ctx;
			if (active >= limit) {
				response.setHeader('Retry-After', '1');
				throw createHttpError(503, 'Server capacity reached. Retry later.');
			}
			if (response.destroyed) {
				throw createHttpError(499, 'Client disconnected.');
			}

			active += 1;
			const controller = new AbortController();
			const abort = () => controller.abort(createHttpError(499, 'Client disconnected.'));
			response.once('close', abort);
			const deadline = setTimeout(() => {
				controller.abort(createHttpError(504, 'Request timed out.'));
				response.destroy();
			}, timeoutMs);
			deadline.unref();

			try {
				return await handler(args, controller.signal);
			} finally {
				active -= 1;
				clearTimeout(deadline);
				response.off('close', abort);
			}
		};
};
