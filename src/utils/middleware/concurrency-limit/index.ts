import type { AuthContext } from '@masumi/payment-core/auth-middleware';
import { Middleware } from 'express-zod-api';
import createHttpError from 'http-errors';
import { z } from '@masumi/payment-core/zod';

const concurrencyLimitInputSchema = z.object({});

type ConcurrencyLimitOptions = {
	limit: number;
	timeoutMs: number;
};

/**
 * Caps how many requests built on ONE middleware instance can be in flight at
 * once, rejecting the rest with 503 instead of letting them pile into memory.
 * Share a single instance across every route that hits the same underlying
 * resource (e.g. several endpoints that all run heavy, unbounded queries
 * against the same DB/heap) so the cap bounds their combined concurrency
 * rather than each route independently.
 *
 * Note: the `timeoutMs` safety net frees the accounting slot and destroys the
 * response, but does not cancel whatever the handler is still doing server
 * side (e.g. an in-flight DB query) — there is no cancellation signal wired
 * into the handler here. It bounds how long one stuck request can hold a
 * slot and stops the server waiting on a client that gave up; it does not by
 * itself bound that request's own resource use past `timeoutMs`.
 */
export const createConcurrencyLimitMiddleware = ({ limit, timeoutMs }: ConcurrencyLimitOptions) => {
	let active = 0;

	return new Middleware<AuthContext, AuthContext, string, typeof concurrencyLimitInputSchema>({
		input: concurrencyLimitInputSchema,
		handler: async ({ ctx, response }) => {
			if (active >= limit) {
				response.setHeader('Retry-After', '1');
				throw createHttpError(503, 'Server capacity reached. Retry later.');
			}

			active += 1;
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				active -= 1;
				clearTimeout(deadline);
				response.off('finish', release);
				response.off('close', release);
			};
			// Safety net: if the response never fires finish/close (a hung
			// handler or query), don't leak the slot for the rest of the process.
			// Destroying the response also stops the server holding that specific
			// connection open forever for a client that gave up, and makes the
			// eventual (still in-flight) write fail fast instead of succeeding
			// against a socket nobody is reading from.
			const deadline = setTimeout(() => {
				response.destroy();
				release();
			}, timeoutMs);
			deadline.unref();
			response.once('finish', release);
			response.once('close', release);

			return ctx;
		},
	});
};
