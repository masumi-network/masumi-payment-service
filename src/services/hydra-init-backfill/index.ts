/**
 * Record the InitTx on the side that did not post it.
 *
 * Both participants are in the same head, on the same chain, looking at the
 * same transaction — but `initTxHash` was only ever written by whoever ran
 * `initHeadPost`. The acceptor's head sat with a null hash indefinitely, so one
 * operator could see the opening transaction and the other could not.
 *
 * The verification itself is already symmetric: it looks the head up on chain by
 * its identifier and checks the participant keys, with no reference to who
 * submitted anything. Nothing needed to be built — it simply was never called
 * from the acceptor's side.
 *
 * The hash is not cosmetic. L2 routing is quarantined while it is null, which is
 * deliberate for the initiator (whose Init may not have been observed yet) but
 * was permanent for the acceptor.
 */

import { HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { verifyPersistedHydraHeadOnChain } from '@/routes/api/hydra/head';

/** Bounded so one pass cannot spend the tick on chain lookups. */
const MAX_PER_CYCLE = 5;

/**
 * One pass over heads that are live but have no recorded opening transaction,
 * or no chain-replay anchor yet (initChainSlot/initChainHash; heads verified
 * before the anchor columns existed). Verification persists both.
 *
 * Only heads past Initializing are considered: before that there may genuinely
 * be no InitTx on chain yet, and asking would fail every cycle.
 */
export async function backfillHydraInitTxHashes(): Promise<number> {
	const heads = await prisma.hydraHead.findMany({
		where: {
			isEnabled: true,
			OR: [{ initTxHash: null }, { initChainSlot: null }],
			headIdentifier: { not: null },
			status: { in: [HydraHeadStatus.Open, HydraHeadStatus.Closed, HydraHeadStatus.FanoutPossible] },
		},
		select: { id: true },
		take: MAX_PER_CYCLE,
	});

	let recorded = 0;
	for (const head of heads) {
		try {
			await verifyPersistedHydraHeadOnChain(head.id);
			recorded += 1;
			logger.info(`hydra: recorded the opening transaction for head ${head.id}`);
		} catch (error) {
			// Expected while the chain index is still catching up. Left for the next
			// pass rather than logged as an error, since nothing is wrong yet.
			logger.debug(`hydra: could not yet observe the InitTx for head ${head.id}: ${(error as Error).message}`);
		}
	}
	return recorded;
}
