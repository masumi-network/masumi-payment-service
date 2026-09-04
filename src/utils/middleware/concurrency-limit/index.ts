import type { NextFunction, Request, Response } from 'express';
import createHttpError from 'http-errors';

export type ConcurrencyLimitOptions = {
	/** Maximum number of requests allowed to be in flight at once. */
	limit: number;
	/** Hard ceiling on how long one request may hold a slot before it is force-released. */
	responseTimeoutMs?: number;
	retryAfterSeconds?: number;
};

const DEFAULT_RESPONSE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RETRY_AFTER_SECONDS = 1;


export function createConcurrencyLimitMiddleware({
	limit,
	responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
	retryAfterSeconds = DEFAULT_RETRY_AFTER_SECONDS,
}: ConcurrencyLimitOptions) {
	let active = 0;

	return (_req: Request, res: Response, next: NextFunction) => {
		if (active >= limit) {
			res.setHeader('Retry-After', String(retryAfterSeconds));
			next(createHttpError(503, 'Server capacity reached. Retry later.'));
			return;
		}

		active += 1;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			active -= 1;
			clearTimeout(deadline);
		};

		// A hung or dropped response would otherwise hold this slot forever and
		// permanently shrink the effective limit by one.
		const deadline = setTimeout(() => {
			res.destroy();
			release();
		}, responseTimeoutMs);
		deadline.unref();

		res.once('finish', release);
		res.once('close', release);
		next();
	};
}
