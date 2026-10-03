/**
 * Shared pacing for the in-head passes.
 *
 * Every L2 action — locking funds, submitting a result, collecting, refunding —
 * is one wallet building one transaction at a time, held from submit until the
 * head confirms. That confirmation takes milliseconds, but a pass that gives up
 * on its own wallet ends there, and the next pass only starts on a nudge. Whole
 * queues therefore drained one item per nudge, which read as Hydra being slow
 * when it was this loop: the transactions themselves build, sign and submit in
 * about twenty milliseconds.
 *
 * Here rather than per service so the paths pace identically. Divergent timings
 * were how submitting a result ended up an order of magnitude slower than
 * locking the funds it answers, inside the same head.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

/**
 * How long to wait for a wallet the pass itself just used.
 *
 * Only has to outlast an in-head round trip, not a chain confirmation. Past it,
 * something other than ordinary settlement is going on, and the next pass is
 * the right place to find out rather than blocking this one.
 */
export const WALLET_SETTLE_TIMEOUT_MS = 3_000;
export const WALLET_SETTLE_POLL_MS = 25;

/**
 * How many times a pass may re-run before yielding.
 *
 * A backstop, not a target: the loop already stops as soon as a round does no
 * work. This bounds the damage if a round reports progress it did not make,
 * which would otherwise spin until the process was killed.
 */
export const L2_PASS_MAX_ROUNDS = 200;

/**
 * How long a drain may keep going before yielding.
 *
 * The round cap alone is not enough of a guard: each round queries and claims,
 * so a pass that keeps reporting work can hold database connections for as long
 * as it takes to burn through every round. That is not hypothetical — it
 * exhausted the pool the first time this loop shipped. Time bounds the damage
 * in the units that actually matter to everything else sharing the pool.
 */
export const L2_PASS_MAX_DURATION_MS = 20_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Whether a wallet is free to build with, waiting briefly when it is worth it.
 *
 * Always re-read from the database: the snapshot a pass started with reports a
 * wallet busy for the whole pass once it has been used, which is what stopped
 * passes after a single item.
 *
 * `mayWait` should be true only for a wallet this pass itself submitted with.
 * One busy for any other reason belongs to work this pass cannot see the end
 * of, and blocking on it would stall the cycle behind someone else's.
 */
export async function waitForFreeWallet(walletId: string, mayWait: boolean): Promise<boolean> {
	const deadline = Date.now() + (mayWait ? WALLET_SETTLE_TIMEOUT_MS : 0);
	for (;;) {
		const wallet = await prisma.hotWallet.findUnique({
			where: { id: walletId },
			select: { lockedAt: true, pendingTransactionId: true },
		});
		if (wallet == null) return false;
		if (wallet.lockedAt == null && wallet.pendingTransactionId == null) return true;
		if (Date.now() >= deadline) return false;
		await sleep(WALLET_SETTLE_POLL_MS);
	}
}

/**
 * Run a pass until it stops finding work.
 *
 * For passes that claim one item per wallet per round — the shape most of the
 * in-head services have, because a wallet can only own one pending transaction.
 * Without this, such a pass does one item and hands the rest to the next nudge.
 *
 * `runOnce` must return how many items it CARRIED TO COMPLETION, not how many
 * it selected. Counting selections spins: a request whose state only changes
 * once the head confirms is still eligible on the next round, so the loop keeps
 * being told it made progress and hammers the database until the connection
 * pool gives out. That is not hypothetical; it is why this is not yet wired
 * into the services that need it.
 *
 * NOT IN USE. Kept, with its tests, because the shape is right and the lock
 * pass already proves the underlying idea — waiting on the head rather than the
 * next nudge took locking from 1/s to 3.3/s. What is missing is a per-service
 * answer to "what counts as done", and inventing one per service without
 * measuring each is how the pool got exhausted.
 */
export async function drainL2Pass(label: string, runOnce: () => Promise<number>): Promise<number> {
	const deadline = Date.now() + L2_PASS_MAX_DURATION_MS;
	let handled = 0;
	for (let round = 0; round < L2_PASS_MAX_ROUNDS; round++) {
		const count = await runOnce();
		if (count === 0) return handled;
		handled += count;
		if (Date.now() >= deadline) {
			// Yield rather than finish the queue. Whatever is left is picked up by
			// the next nudge, which a completed round will have triggered anyway.
			logger.info(`[L2Pass] ${label} yielding after ${L2_PASS_MAX_DURATION_MS}ms`, { handled });
			return handled;
		}
	}
	// Reached only if every round claimed progress, which after this many rounds
	// is more likely a pass that miscounts than a queue that deep.
	logger.warn(`[L2Pass] ${label} stopped after ${L2_PASS_MAX_ROUNDS} rounds with work still reported`, { handled });
	return handled;
}
