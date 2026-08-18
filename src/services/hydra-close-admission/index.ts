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
 * `Closed` or rolls it back — so a Close that is dispatched and then fails on
 * chain (the node's own key out of ADA, the node out of sync) leaves a head
 * that is `Open`, healthy, and permanently refused: every retry of close answers
 * 409 "already in progress", every L2 escrow operation is refused by the
 * submission gate, and fanout is unreachable because the status never advances.
 * The funds in the head come out only by editing the row by hand.
 *
 * So the latch is released, but only against the node's own answer: the session
 * is re-flushed first, and the release is a compare-and-set that still requires
 * the head to be `Open` with no close transaction recorded. Anything that
 * actually closed advances instead, and keeps the latch.
 */

import { HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';

/**
 * How long a head may sit admitted-but-not-closing before this looks at it.
 *
 * Generous, because the normal case resolves in seconds: the node posts the
 * CloseTx and the lifecycle frame arrives. Anything still here after this long
 * is a close that did not happen.
 */
export const STALLED_CLOSE_AFTER_MS = 10 * 60 * 1000;

/**
 * Clear the close latch on heads whose node still reports them Open.
 *
 * Returns how many were released.
 */
export async function releaseStalledCloseAdmissions(): Promise<number> {
	const stalled = await prisma.hydraHead.findMany({
		where: {
			status: HydraHeadStatus.Open,
			isClosing: true,
			isEnabled: true,
			closeTxHash: null,
			// `closingSince`, not `updatedAt`. The latter is @updatedAt, and the
			// connection manager writes the row on every successful attach — it
			// increments the ownership fence — so a head whose node session flaps more
			// often than this window never looked stale and its stuck latch was never
			// released, refusing new L2 work on a head that is still Open.
			closingSince: { lt: new Date(Date.now() - STALLED_CLOSE_AFTER_MS) },
		},
		select: { id: true },
	});
	if (stalled.length === 0) {
		return 0;
	}

	const manager = getHydraConnectionManager();
	let released = 0;
	for (const head of stalled) {
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

		const cleared = await prisma.hydraHead.updateMany({
			where: {
				id: head.id,
				status: HydraHeadStatus.Open,
				isClosing: true,
				isEnabled: true,
				closeTxHash: null,
			},
			data: { isClosing: false, closingSince: null },
		});
		if (cleared.count === 1) {
			released += 1;
			logger.warn(
				`[HydraCloseAdmission] Released the close latch on head ${head.id}; it was admitted for a close that never ` +
					'reached the chain, and the head is still Open. Close it again to retry',
			);
		}
	}
	return released;
}
