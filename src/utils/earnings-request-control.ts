import { createAuthenticatedRateLimitMiddleware } from '@/utils/middleware/rate-limit';
import { createConcurrencyLimitMiddleware } from '@/utils/middleware/concurrency-limit';

/**
 * /payment/income and /purchase/spending both run unbounded, full-history
 * aggregation queries (see earnings-helpers.ts) against the same DB/heap. One
 * shared instance caps their COMBINED concurrency so hammering either
 * endpoint (or both at once) can't multiply into a heap-exhaustion crash.
 */
export const earningsConcurrencyMiddleware = createConcurrencyLimitMiddleware({
	limit: 4,
	timeoutMs: 5 * 60_000,
});

export const createEarningsRateLimitMiddleware = () =>
	createAuthenticatedRateLimitMiddleware({
		maxRequests: 30,
		windowMs: 60_000,
	});
