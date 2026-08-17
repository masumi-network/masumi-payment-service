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
			OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
		},
		data: { lockedAt: new Date() },
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
 */
export async function releaseHotWalletAfterL1(walletId: string): Promise<void> {
	try {
		await prisma.hotWallet.updateMany({
			where: { id: walletId, pendingTransactionId: null },
			data: { lockedAt: null },
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
