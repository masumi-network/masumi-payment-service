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

// Postgres SQLSTATE codes we additionally treat as retryable. These surface
// through `@prisma/adapter-pg` as `DriverAdapterError` (NOT PrismaClient*Error)
// with `name === 'DriverAdapterError'` and the SQLSTATE on either `error.code`
// or `error.cause.code` depending on where the adapter intercepted.
//
// 40001 — serialization_failure (same root cause as P2034)
// 40P01 — deadlock_detected
// 25001 — "SET TRANSACTION ISOLATION LEVEL must be called before any query".
//   Surfaces when the previous tx on this pooled connection was aborted
//   mid-flight (e.g. our own $transaction timed out) and the driver tries to
//   start the next tx on the same connection before it has been reset. The
//   next attempt typically picks a fresh connection from the pool and
//   succeeds — so it is retryable.
const POSTGRES_RETRYABLE_SQLSTATES = new Set(['40001', '40P01', '25001']);

type Logger = Pick<typeof logger, 'debug' | 'info' | 'warn'>;

export type RetryOptions = {
	maxRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	label?: string;
	logger?: Logger;
};

// Narrowly-typed shapes for the error inspection below. Defining explicit
// guards (rather than `Record<string, unknown>`) keeps the codebase rule
// `local/no-unknown-valued-maps` happy and documents exactly which fields we
// read from each error layer.
type ErrorWithCode = { code?: unknown; originalCode?: unknown; name?: unknown };
type ErrorWithCause = { cause?: unknown };
type ErrorWithMeta = { meta?: unknown };
type DriverAdapterShape = { driverAdapterError?: unknown };
type DriverAdapterCauseShape = { cause?: unknown };

function asObject(value: unknown): object | undefined {
	return value != null && typeof value === 'object' ? value : undefined;
}

function readStringField(value: unknown, key: 'code' | 'originalCode' | 'name'): string | undefined {
	const obj = asObject(value);
	if (obj == null) return undefined;
	const v = (obj as ErrorWithCode)[key];
	return typeof v === 'string' ? v : undefined;
}

function readSqlstate(value: unknown): string | undefined {
	return readStringField(value, 'originalCode') ?? readStringField(value, 'code');
}

function isSerializationConflict(error: unknown): boolean {
	if (asObject(error) == null) return false;

	// Prisma client errors carry the Prisma code directly on the top-level
	// `code` field (e.g. 'P2034', 'P2028').
	const prismaCode = readStringField(error, 'code');
	if (prismaCode != null && PRISMA_RETRYABLE_CODES.has(prismaCode)) return true;

	// `@prisma/adapter-pg` wraps low-level Postgres errors as
	// `DriverAdapterError` and exposes the SQLSTATE on either the outer
	// error's `code`/`originalCode` or on `error.cause.{code,originalCode}`.
	// Inspect both layers so callers don't have to peel the wrapper.
	const name = readStringField(error, 'name');
	const isDriverAdapter = name === 'DriverAdapterError';
	const outerSqlstate = readSqlstate(error);
	if (isDriverAdapter && outerSqlstate != null && POSTGRES_RETRYABLE_SQLSTATES.has(outerSqlstate)) {
		return true;
	}
	const cause = (error as ErrorWithCause).cause;
	const causeSqlstate = readSqlstate(cause);
	if (causeSqlstate != null && POSTGRES_RETRYABLE_SQLSTATES.has(causeSqlstate)) {
		return true;
	}

	// Some PrismaClientKnownRequestError variants stash the driver-adapter
	// details under `meta.driverAdapterError.cause.{code,originalCode}` —
	// observed when Prisma rewraps a Postgres 40001 from the pg-adapter.
	const meta = asObject((error as ErrorWithMeta).meta);
	const metaDriverError = meta == null ? undefined : (meta as DriverAdapterShape).driverAdapterError;
	const metaDriverErrorObj = asObject(metaDriverError);
	const metaCause = metaDriverErrorObj == null ? undefined : (metaDriverErrorObj as DriverAdapterCauseShape).cause;
	const metaSqlstate = readSqlstate(metaCause);
	if (metaSqlstate != null && POSTGRES_RETRYABLE_SQLSTATES.has(metaSqlstate)) {
		return true;
	}

	return false;
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
	// Defaults sized for Postgres Serializable contention under V1+V2 parallel
	// schedulers: 8 retries × up to 5s = ~30-40s worst-case before a hard
	// failure. CI observed 4 retries × 2s (~775ms total) was too tight — a
	// conflicting tx-sync handler holding HotWallet locks would exhaust the
	// budget mid-commit and surface P2034/P2028 to the caller, leaving the
	// affected request stuck because the outer tx-sync per-entry catch
	// swallows errors per-request.
	const maxRetries = options.maxRetries ?? 8;
	const baseDelayMs = options.baseDelayMs ?? 100;
	const maxDelayMs = options.maxDelayMs ?? 5000;
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
