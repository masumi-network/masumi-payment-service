import { logger } from '@masumi/payment-core/logger';

// Prisma error codes we treat as retryable transaction failures.
//
// P2034 ("Transaction failed due to a write conflict or a deadlock") —
//   the canonical serializable-conflict code. Postgres 40001 wrapped here.
//
// P2028 ("Transaction API error") — Prisma's catch-all for transactions
//   that got closed/aborted by the driver adapter. In the Neon serverless
//   adapter (and similar pooled adapters), serializable-conflict aborts can
//   surface as P2028 with empty meta INSTEAD of P2034 (the driver-adapter
//   layer re-wraps the underlying 40001). Empirically: under V1+V2 parallel
//   schedulers contending on HotWallet rows, P2028 spam ≫ P2034 in the
//   shared-API-server e2e setup. Both are safe to retry: the next attempt
//   opens a fresh transaction with a fresh consistent snapshot.
const PRISMA_RETRYABLE_CODES = new Set(['P2034', 'P2028']);

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
	return typeof code === 'string' && PRISMA_RETRYABLE_CODES.has(code);
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
