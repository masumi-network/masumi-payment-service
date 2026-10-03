/**
 * Telling a dropped Init apart from one the node has simply not seen yet.
 *
 * Opening a head posts an InitTx and then waits for the node to report
 * `HeadIsInitializing`. When that wait runs out the code used to draw one
 * conclusion — the chain backend swallowed the transaction and the node is
 * wedged — and recorded a CommandFailed against the head.
 *
 * That is only one of the two ways the wait can end. The Blockfrost chain
 * follower sleeps a full block time before every block and runs its delay-free
 * catch-up only at startup, so a node that has fallen behind stays behind; we
 * have watched one sit hours from the tip. Such a node cannot observe an InitTx
 * inside the wait no matter how cleanly it landed, and the head then opens by
 * itself once the follower arrives — leaving a recorded error against a head
 * that worked, which is how an operator learns to disregard head errors.
 *
 * The node's own health answers the question the timeout cannot: a node that
 * says it has not caught up has not failed to post anything, it is behind.
 */

import { HydraHeadStatus } from '@/generated/prisma/client';
import { formatDriftBehind, hasNoChainPoint } from '@/utils/hydra/drift-wording';

/** Statuses that mean the Init was observed after all, timeout notwithstanding. */
const OBSERVED_STATUSES: ReadonlySet<HydraHeadStatus> = new Set([HydraHeadStatus.Initializing, HydraHeadStatus.Open]);

export type InitObservationVerdict =
	/** The head moved on while we were deciding. Nothing failed. */
	| { kind: 'observed' }
	/** Posted, and this node is too far behind to have seen it yet. */
	| { kind: 'awaiting-node'; message: string }
	/** Nothing accounts for the silence; treat it as the failure it may well be. */
	| { kind: 'failed' };

/**
 * Seconds as something an operator can weigh, matching the node-state wording.
 *
 * A node with no chain point yet reports slot 0, which converts to a gap of
 * years; saying so here would put "is about 36514 hours behind the chain" in
 * the middle of a sentence explaining that nothing is wrong.
 */
function describeDrift(driftSeconds: number | null): string {
	if (hasNoChainPoint(driftSeconds)) return 'has not started following the chain yet';
	const behind = driftSeconds === null ? null : formatDriftBehind(driftSeconds);
	if (behind === null) return 'is still catching up with the chain';
	return `is about ${behind} behind the chain`;
}

/**
 * What to conclude when Init was posted but never observed.
 *
 * `headStatus` is read AFTER draining any frames that arrived late, so an Init
 * that landed in the meantime is recognised rather than recorded as a failure.
 * `chainSynced` null means the Host could not be asked — which is not evidence
 * the node is behind, so it falls through to the failure it looks like.
 */
export function classifyInitObservation(input: {
	headStatus: HydraHeadStatus;
	chainSynced: boolean | null;
	driftSeconds: number | null;
}): InitObservationVerdict {
	if (OBSERVED_STATUSES.has(input.headStatus)) return { kind: 'observed' };
	if (input.chainSynced === false) {
		return {
			kind: 'awaiting-node',
			message:
				`The Init transaction was posted, but this head's hydra node ${describeDrift(input.driftSeconds)} ` +
				'and has not observed it yet. Nothing is lost and nothing needs re-sending: the head moves to ' +
				'Initializing on its own once the node catches up. Posting Init again would race the first one for ' +
				'the same seed input.',
		};
	}
	return { kind: 'failed' };
}
