/**
 * Holding a hot wallet for the duration of one L1 operation.
 *
 * Every other L1 spender in this service claims its wallet before it builds:
 * the payment, purchase and registry batchers all select only wallets with
 * `lockedAt: null` and `PendingTransaction: { is: null }`, and set `lockedAt`
 * inside the same serializable transaction that picks the request. That lock is
 * what stops two builders choosing the same UTxO as an input — the loser's
 * transaction is rejected on chain with `BadInputsUTxO`, having already been
 * signed and submitted.
 *
 * The Hydra L1 deposits — the opening commit, and every top-up carve — spend
 * the same `HotWallet` rows and did not take part. A collect running on the
 * seller's wallet and a top-up carving a UTxO out of it are two builders over
 * one set of inputs, and the operator learns which one lost from a chain error.
 *
 * So they take the same lock, over the whole operation rather than over the
 * build: a carve waits for its own confirmation before the commit selects it,
 * and a UTxO spent inside that wait is just as gone.
 */

import createHttpError from 'http-errors';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

/**
 * When a bare lock may be taken over.
 *
 * A crash between claiming a wallet and releasing it would otherwise strand it
 * for good — no batcher would ever pick it again, and nothing in the service
 * clears the field. Only a lock with no pending transaction behind it is
 * eligible, so a batcher waiting on a submitted transaction is never disturbed,
 * and the threshold is far beyond any operation that takes one: the longest,
 * a carve, gives up after five minutes.
 */
export const HOT_WALLET_LOCK_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * What `HotWallet.lockPurpose` says while a Hydra L1 deposit holds the wallet.
 *
 * The generic safety net, `unlockStaleOrphanWalletLocks`, frees any lock with
 * no pending transaction after CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL — 300s by
 * default. That is right for the batchers, which attach a PendingTransaction
 * within seconds of claiming, and wrong for these, which hold the lock across a
 * full L1 confirmation and never attach one: a carve waits up to five minutes
 * for its own confirmation, so the reaper handed the wallet to a batcher while
 * the carve was still in flight and one of the two spends died on chain as
 * BadInputsUTxO. The marker takes these locks out of that pass and puts them
 * under `HOT_WALLET_LOCK_STALE_AFTER_MS` instead.
 */
export const HYDRA_L1_LOCK_PURPOSE = 'hydra-l1';

/**
 * Claim a hot wallet, or refuse.
 *
 * The claim is one statement, so two callers cannot both pass the test: the
 * loser updates nothing and is told the wallet is busy.
 */
export async function claimHotWalletForL1(walletId: string, purpose: string): Promise<void> {
	const staleBefore = new Date(Date.now() - HOT_WALLET_LOCK_STALE_AFTER_MS);
	const claimed = await prisma.hotWallet.updateMany({
		where: {
			id: walletId,
			deletedAt: null,
			pendingTransactionId: null,
			// Swaps hold the wallet through a different column and never attach a
			// PendingTransaction, so `pendingTransactionId: null` alone reads a
			// mid-swap wallet as free. Past HOT_WALLET_LOCK_STALE_AFTER_MS a stuck
			// swap would hand its wallet to a deposit, which then builds over the
			// UTxOs the swap tx spends — the same BadInputsUTxO coin toss the
			// marker exists to prevent.
			pendingSwapTransactionId: null,
			OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
		},
		data: { lockedAt: new Date(), lockPurpose: HYDRA_L1_LOCK_PURPOSE },
	});
	if (claimed.count !== 1) {
		throw createHttpError(
			409,
			`The wallet for this ${purpose} is busy with another transaction. It is released when that one finishes; try again then`,
		);
	}
}

/**
 * Release a wallet this operation claimed.
 *
 * Guarded on there being no pending transaction, so a release arriving after
 * some other holder has attached one cannot free a wallet that is mid-flight.
 *
 * Call it only once this operation has no L1 transaction of its own left
 * outstanding. A Hydra commit or deposit is submitted, not confirmed, when the
 * request returns: releasing there let a batcher pick the wallet up, read its
 * UTxOs from Blockfrost — which still reports the inputs the unconfirmed
 * transaction spends — and build a second transaction over the same input. One
 * of the two is then rejected on chain as `BadInputsUTxO`, and which one is a
 * coin toss. The commit and top-up paths therefore hold the lock while their
 * transaction is pending, and their reconcilers release it.
 */
export async function releaseHotWalletAfterL1(walletId: string): Promise<void> {
	try {
		await prisma.hotWallet.updateMany({
			// Scoped to this operation's own marker as well as to there being no
			// pending transaction. Without it a late release — a reconciler landing
			// after the generic reaper had already freed the wallet and a batcher had
			// claimed it — would clear a lock this operation does not hold, during
			// the batcher's build window before its PendingTransaction exists.
			where: { id: walletId, pendingTransactionId: null, lockPurpose: HYDRA_L1_LOCK_PURPOSE },
			data: { lockedAt: null, lockPurpose: null },
		});
	} catch (error) {
		// Never allowed to replace the operation's own outcome: a failed release
		// costs one stale lock, which ages out, while a throw here would report a
		// completed deposit as a failure.
		logger.error('Could not release a hot wallet after a Hydra L1 operation', {
			walletId,
			error: (error as Error).message,
		});
	}
}

// Claim and release are exported separately rather than as one wrapper because
// both call sites already own a long try/catch that records the head's error
// state; the release belongs in a `finally` on that same block, where it also
// covers the early returns inside it.
