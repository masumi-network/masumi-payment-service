/**
 * When a top-up hands its hot wallet back.
 *
 * The wallet is claimed for the whole operation, not for the build: a carve
 * waits for its own confirmation before the deposit spends it, and a UTxO spent
 * inside that wait is just as gone. So the release has two questions to answer,
 * and both are about THIS operation rather than about the participant.
 *
 * Asked participant-wide, the commonest failure answered wrongly. A call that is
 * refused because an earlier top-up is still Pending has put nothing on chain,
 * but it sees that earlier row, holds the lock it just took, and the wallet
 * leaves every L1 batcher for the full `HOT_WALLET_LOCK_STALE_AFTER_MS` window.
 * With an unresolvable Pending row — one whose deposit expired while the
 * reconciler was down — the thirty-second auto-top-up cycle renews that lock
 * indefinitely and the payment batchers never see the wallet again.
 *
 * Pure and separate so both halves can be pinned without a database.
 */

import { logger } from '@masumi/payment-core/logger';
import { HydraTopupStatus, type Prisma } from '@/generated/prisma/client';

/**
 * The row this operation created, while it may still put a deposit on chain.
 *
 * Named by id. A participant-wide filter reads another operation's row as a
 * reason to keep a lock this operation is the only holder of.
 */
export function outstandingOwnTopupWhere(topupId: string): Prisma.HydraTopupWhereInput {
	return { id: topupId, status: { in: [HydraTopupStatus.Pending, HydraTopupStatus.Preparing] } };
}

/**
 * Whether the wallet can be handed back now.
 *
 * A signed carve is a transaction that may be in the mempool, and a failure
 * afterwards says nothing about that: until it settles, the inputs it spends
 * still read as unspent, so handing the wallet back lets the next batch tick
 * build over them and lose one of the two to `BadInputsUTxO`. A confirmed
 * deposit settles the carve too, since the deposit spends the carve's output.
 */
export function canReleaseTopupWallet(state: {
	outstandingOwnTopup: boolean;
	carveTxHash: string | null;
	depositConfirmed: boolean;
}): boolean {
	if (state.outstandingOwnTopup) return false;
	return state.carveTxHash === null || state.depositConfirmed;
}

/**
 * Whether this operation's own row is still outstanding, asked safely.
 *
 * The caller asks from a `finally`. A throw there replaces the outcome the
 * operation actually had — a submitted deposit reported as a failure, or one
 * error reported as another — so the question is asked through this, which
 * answers rather than throws. A probe that could not answer is not an answer of
 * "nothing outstanding": it keeps the wallet held and leaves it to the
 * stale-lock sweep, which is half an hour of one wallet rather than two
 * transactions over one input.
 */
export async function isOwnTopupOutstanding(
	topupId: string | null,
	probe: (topupId: string) => Promise<boolean>,
): Promise<boolean> {
	if (topupId === null) return false;
	try {
		return await probe(topupId);
	} catch (error: unknown) {
		logger.warn('hydra-topup: could not check whether this top-up is still outstanding; keeping the wallet lock', {
			topupId,
			error: error instanceof Error ? error.message : 'Non-error failure',
		});
		return true;
	}
}
