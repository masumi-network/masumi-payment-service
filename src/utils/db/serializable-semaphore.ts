import { Semaphore } from 'async-mutex';
import { logger } from '@masumi/payment-core/logger';
import { retryOnSerializationConflict, type RetryOptions } from '@/utils/db/retry';

/**
 * Concurrency cap for Serializable interactive transactions issued by the
 * `lockAndQuery*` helpers.
 *
 * Why this exists
 * ---------------
 * Each `prisma.$transaction(..., { isolationLevel: 'Serializable' })` pins one
 * connection from the underlying pg `Pool` for the full duration of the
 * interactive transaction. The pool is sized by `connection_limit` on
 * `DATABASE_URL` (default 5, see `packages/payment-core/src/db.ts`).
 *
 * The `lockAndQuery*` helpers fan out per-wallet Serializable transactions in
 * parallel: with N payment sources × M unlocked hot wallets, a single tick can
 * spawn N×M concurrent interactive transactions. Without a cap, this exhausts
 * the connection pool, queues every additional transaction at `maxWait`, then
 * throws `Timed out fetching a new connection from the connection pool`.
 *
 * The semaphore is a MODULE-LEVEL SINGLETON so every `lockAndQuery*` caller
 * shares the same budget — otherwise N independent caps would each saturate
 * the pool on their own.
 *
 * Sizing
 * ------
 * Default = `connection_limit - 1`, leaving one connection for read-only
 * traffic (Step-1 `paymentSource.findMany` reads, tx-sync probes, low-balance
 * scans, etc). Without this headroom every connection is held by a
 * `$transaction` and the read path stalls.
 *
 * Override via `DB_SERIALIZABLE_CONCURRENCY=N` for ops emergencies without
 * touching `DATABASE_URL`. Values below 1 are clamped to 1.
 */

function deriveSerializableLimit(): number {
	const url = process.env.DATABASE_URL;

	// Pull connection_limit from DATABASE_URL — same source the Prisma pool
	// reads. If unset or malformed, mirror db.ts's default of 5.
	let connectionLimit = 5;
	if (url != null) {
		try {
			const parsed = new URL(url);
			const raw = parsed.searchParams.get('connection_limit');
			if (raw != null) {
				const n = Number.parseInt(raw, 10);
				// Accept any operator-set value >= 1; the `Math.max(1, n - 1)`
				// clamp below floors the slot count to 1 even when
				// connection_limit is 1. Rejecting `n == 1` here would silently
				// fall back to the hardcoded default of 5 and oversubscribe the
				// pool — the exact symptom this semaphore exists to prevent.
				if (Number.isFinite(n) && n >= 1) connectionLimit = n;
			}
		} catch {
			// Malformed URL — db.ts handles the real error path; fall through with default.
		}
	}

	const override = process.env.DB_SERIALIZABLE_CONCURRENCY;
	if (override != null) {
		const n = Number.parseInt(override, 10);
		if (Number.isFinite(n) && n >= 1) return n;
		logger.warn(`Ignoring invalid DB_SERIALIZABLE_CONCURRENCY="${override}"; falling back to connection_limit-1`);
	}

	// Leave 1 connection of headroom for non-tx reads. Minimum cap of 1.
	return Math.max(1, connectionLimit - 1);
}

export const SERIALIZABLE_DB_CONCURRENCY = deriveSerializableLimit();

const serializableDbSemaphore = new Semaphore(SERIALIZABLE_DB_CONCURRENCY);

logger.info(
	`Serializable DB transaction concurrency capped at ${SERIALIZABLE_DB_CONCURRENCY} ` +
		`(set DB_SERIALIZABLE_CONCURRENCY to override; sized from DATABASE_URL connection_limit by default).`,
);

/**
 * Run an operation that opens a Serializable interactive transaction, gated
 * by the shared `lockAndQuery*` semaphore. Use this around any `$transaction`
 * call that holds a connection long enough to risk pool exhaustion under
 * parallel fan-out.
 *
 * Light-weight non-tx reads MUST NOT acquire this — they don't pin a
 * connection for the full operation and would needlessly starve the
 * transaction budget.
 *
 * Usage:
 *
 *   await withSerializableSlot(() =>
 *     retryOnSerializationConflict(
 *       () => prisma.$transaction(async (tx) => { ... }, { isolationLevel: 'Serializable' }),
 *       { label: 'myHelper' },
 *     ),
 *   );
 */
export async function withSerializableSlot<T>(operation: () => Promise<T>): Promise<T> {
	const [, release] = await serializableDbSemaphore.acquire();
	try {
		return await operation();
	} finally {
		release();
	}
}

/**
 * Retry a Serializable transaction on serialization conflict, acquiring the
 * shared connection slot PER ATTEMPT rather than holding it across the whole
 * retry loop.
 *
 * Why the nesting order matters: the obvious composition
 *
 *   withSerializableSlot(() => retryOnSerializationConflict(() => $tx, opts))
 *
 * holds the scarce DB connection slot for the ENTIRE retry sequence —
 * including `retryOnSerializationConflict`'s exponential backoff sleeps
 * between attempts. Under a burst of 40001/deadlock conflicts (exactly when
 * the parallel `lockAndQuery*` fan-out is busiest), every retrying wallet sits
 * on a slot while merely sleeping, starving other wallets that have real work
 * ready to run and can turn pool exhaustion into a self-inflicted stall.
 *
 * This helper inverts the nesting:
 *
 *   retryOnSerializationConflict(() => withSerializableSlot(() => $tx), opts)
 *
 * so the slot is acquired just before each attempt and RELEASED before the
 * backoff sleep, letting a different wallet make progress during the wait.
 * The transaction still runs entirely inside a slot (correctness unchanged);
 * only the idle backoff time no longer pins a connection.
 */
export async function withSerializableSlotRetry<T>(
	operation: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	return retryOnSerializationConflict(() => withSerializableSlot(operation), options);
}

/**
 * Test-only escape hatch. Do not use in production code paths.
 */
export function __getSerializableSemaphoreForTesting() {
	return serializableDbSemaphore;
}
