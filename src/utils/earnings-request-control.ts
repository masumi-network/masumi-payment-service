import { createConcurrencyLimit } from '@/utils/middleware/concurrency-limit';

export const EARNINGS_CONCURRENCY_LIMIT = 4;
export const EARNINGS_REQUEST_TIMEOUT_MS = 5 * 60_000;

export const withEarningsConcurrency = createConcurrencyLimit({
	limit: EARNINGS_CONCURRENCY_LIMIT,
	timeoutMs: EARNINGS_REQUEST_TIMEOUT_MS,
});

export { concurrencyResponseMiddleware } from '@/utils/middleware/concurrency-limit';
