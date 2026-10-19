/**
 * Releasing a close admission that no close ever followed.
 *
 * `HydraHead.isClosing` is a one-way latch by design: once a Close has been put
 * on the wire, nothing may treat the head as usable again on the strength of a
 * local guess, because the head may be closing right now and an L2 transaction
 * accepted in that window is one the ledger will never see.
 *
 * The latch has no natural release, though. It is set before the command is
 * sent and cleared only by an authenticated status frame that moves the head to
 * `Closed` or rolls it back — so a Close that the node refuses (its own key out
 * of ADA, say) leaves a head that is `Open`, healthy, and permanently refused:
 * every retry of close answers 409 "already in progress", every L2 escrow
 * operation is refused by the submission gate, and fanout is unreachable
 * because the status never advances.
 *
 * Neither elapsed time nor the node reporting `Open` shows that a Close is dead.
 * A node parks commands it cannot act on yet (one behind the chain holds them
 * until it is synced), and a parked Close posts whenever the node gets to it, so
 * a head that has looked stalled for an hour can still close a minute later.
 * The release therefore takes two proofs, in this order:
 *
 *   1. the command cannot still execute — the node refused it
 *      (`closeRefusedAt`, written only from its CommandFailed or
 *      PostTxOnChainFailed answer to this Close);
 *   2. no other Close happened — an independent L1 read of the head's state
 *      token still shows the Open datum.
 *
 * A Close with no refusal on record keeps its latch however long it waits.
 */

import { HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { readHeadChainState } from '@/routes/api/hydra/head/chain-check';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';

/**
 * How long a refusal must stand before L1 is asked.
 *
 * Not a release timer: nothing is released without the refusal and the L1
 * read. The refusal frames carry no correlation id, so a Close sent to the same
 * node by another client can be refused while ours is in the mempool, and
 * Blockfrost only indexes confirmed transactions. Waiting lets such a CloseTx
 * reach a block, where the L1 read sees it and keeps the latch.
 */
export const CLOSE_REFUSAL_SETTLE_MS = 10 * 60 * 1000;

/**
 * Clear the close latch on heads whose node refused the Close and whose state
 * on L1 is still Open.
 *
 * Returns how many were released.
 */
export async function releaseStalledCloseAdmissions(): Promise<number> {
	const refused = await prisma.hydraHead.findMany({
		where: {
			status: HydraHeadStatus.Open,
			isClosing: true,
			isEnabled: true,
			closeTxHash: null,
			closeRefusedAt: { lt: new Date(Date.now() - CLOSE_REFUSAL_SETTLE_MS) },
		},
		select: { id: true, closeRefusedAt: true },
	});
	if (refused.length === 0) {
		return 0;
	}

	const manager = getHydraConnectionManager();
	let released = 0;
	for (const head of refused) {
		// No session means no authority to say anything about this head, and the
		// safe answer while a Close may be in flight is to leave the latch alone.
		if (manager.getHead(head.id) === null) {
			continue;
		}
		try {
			// The node's own answer, authenticated, persisted by the same path that
			// would move the head to Closed. Anything that really closed leaves the
			// CAS below matching nothing.
			await manager.flushHeadStatus(head.id);
		} catch (error) {
			logger.warn(`[HydraCloseAdmission] Could not refresh head ${head.id} before releasing its close latch`, {
				error: (error as Error).message,
			});
			continue;
		}

		// The refusal covers this node's Close only. The other party can close the
		// head too, and the node may not have seen it yet; L1 has.
		try {
			const { state, latestTxHash } = await readHeadChainState(head.id);
			if (state !== 'open') {
				logger.warn(
					`[HydraCloseAdmission] Keeping the close latch on head ${head.id}: its node refused the Close, but ` +
						`L1 shows the head ${state} (tx ${latestTxHash})`,
				);
				continue;
			}
		} catch (error) {
			logger.warn(`[HydraCloseAdmission] Could not read head ${head.id} on L1 before releasing its close latch`, {
				error: (error as Error).message,
			});
			continue;
		}

		const cleared = await prisma.hydraHead.updateMany({
			where: {
				id: head.id,
				status: HydraHeadStatus.Open,
				isClosing: true,
				isEnabled: true,
				closeTxHash: null,
				// The refusal this pass aged and checked L1 for, not merely a refusal:
				// a new attempt refused meanwhile has not had its settle window.
				closeRefusedAt: head.closeRefusedAt,
			},
			data: { isClosing: false, closingSince: null, closeRefusedAt: null },
		});
		if (cleared.count === 1) {
			released += 1;
			logger.warn(
				`[HydraCloseAdmission] Released the close latch on head ${head.id}; its node refused the Close and the ` +
					'head is still Open on L1. Close it again to retry',
			);
		}
	}
	return released;
}
