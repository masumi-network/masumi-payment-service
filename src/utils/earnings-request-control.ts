import { createAuthenticatedRateLimitMiddleware } from '@/utils/middleware/rate-limit';
import { createConcurrencyLimit } from '@/utils/middleware/concurrency-limit';

export const EARNINGS_CONCURRENCY_LIMIT = 4;
export const EARNINGS_REQUEST_TIMEOUT_MS = 5 * 60_000;

/**
 * /payment/income and /purchase/spending both run unbounded, full-history
 * aggregation queries (see earnings-helpers.ts) against the same DB/heap. One
 * shared instance caps their COMBINED concurrency so hammering either
 * endpoint (or both at once) can't multiply into a heap-exhaustion crash.
 */
export const withEarningsConcurrency = createConcurrencyLimit({
	limit: EARNINGS_CONCURRENCY_LIMIT,
	timeoutMs: EARNINGS_REQUEST_TIMEOUT_MS,
});

export const createEarningsRateLimitMiddleware = () =>
	createAuthenticatedRateLimitMiddleware({
		maxRequests: 30,
		windowMs: 60_000,
	});

export { concurrencyResponseMiddleware } from '@/utils/middleware/concurrency-limit';
