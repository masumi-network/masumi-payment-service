import { logger } from '@masumi/payment-core/logger';

// Prisma error code for "could not serialize access due to read/write
// dependencies among transactions" (Postgres 40001). Surfaces under
// `isolationLevel: 'Serializable'` when concurrent transactions touch
// overlapping row sets — e.g. when the V1 and V2 schedulers both run their
// `lockAndQueryX` against the shared API server's DB at the same scheduler
// tick. The conflict is INHERENTLY retryable: Postgres aborts the loser; the
// retry sees a fresh consistent snapshot.
const PRISMA_SERIALIZATION_FAILURE_CODE = 'P2034';

type Logger = Pick<typeof logger, 'debug' | 'info' | 'warn'>;

export type RetryOptions = {
	maxRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	label?: string;
	logger?: Logger;
};

function isSerializationConflict(error: unknown): boolean {
	if (error == null || typeof error !== 'object') return false;
	const code = (error as { code?: unknown }).code;
	return code === PRISMA_SERIALIZATION_FAILURE_CODE;
}

/**
 * Retry an async operation when it fails with Prisma serialization-failure
 * code P2034 (Postgres 40001). Exponential backoff with jitter, capped at
 * {@link RetryOptions.maxDelayMs}. Non-conflict errors bypass the retry and
 * are rethrown immediately.
 *
 * Use this around `prisma.$transaction(..., { isolationLevel: 'Serializable' })`
 * calls that are known to race with sibling schedulers on shared rows. Wider
 * use is fine — non-conflicting calls never retry.
 */
export async function retryOnSerializationConflict<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
	const maxRetries = options.maxRetries ?? 4;
	const baseDelayMs = options.baseDelayMs ?? 50;
	const maxDelayMs = options.maxDelayMs ?? 2000;
	const label = options.label ?? 'serializable-tx';
	const log = options.logger ?? logger;

	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (!isSerializationConflict(error)) throw error;
			if (attempt === maxRetries) {
				log.warn('Serializable transaction exhausted retries', {
					label,
					attempt,
					maxRetries,
				});
				throw error;
			}
			// Full-jitter exponential backoff: a uniformly-random delay within
			// [0, base * 2^attempt], clamped to maxDelayMs. Spreads retries
			// from concurrent contestants to avoid lockstep collisions.
			const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
			const delay = Math.floor(Math.random() * cap);
			log.debug('Retrying serializable transaction after conflict', {
				label,
				attempt,
				nextDelayMs: delay,
			});
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}
