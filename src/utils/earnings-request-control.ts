import { createConcurrencyLimitMiddleware } from '@/utils/middleware/concurrency-limit';

export const EARNINGS_CONCURRENCY_LIMIT = 4;

export const earningsConcurrencyLimitMiddleware = createConcurrencyLimitMiddleware({
	limit: EARNINGS_CONCURRENCY_LIMIT,
});
