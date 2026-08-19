/**
 * Whether a participant's node can act right now.
 *
 * Provisioned is not the same as ready. A node has to start and catch up on
 * chain before it can post anything, and an L1 action attempted in that window
 * fails as "unreachable" — which names the symptom and leaves an operator
 * looking for a broken node instead of waiting a minute.
 *
 * Shared because two callers need the same answer for opposite reasons: the
 * Init confirmation asks before offering a button, and the head's connection
 * panel asks so an operator can see why nothing is happening.
 */

import { prisma } from '@masumi/payment-core/db';
import { formatDriftBehind, hasNoChainPoint } from '@/utils/hydra/drift-wording';
import { decrypt } from '@/utils/security/encryption';
import { fetchHostNodeHealth } from './client';

export type ParticipantNodeState = {
	state: string;
	isReady: boolean;
	/** Why it is not ready, when it is not. */
	reason: string | null;
	/**
	 * Whether the node has caught up with the chain, and by how far it has not.
	 *
	 * Carried alongside `reason` rather than folded into it because one caller
	 * needs to decide, not only to display: an Init that was never observed means
	 * something quite different when the node is hours behind than when it is
	 * current, and the prose cannot be branched on. Null when the Host could not
	 * be asked at all.
	 */
	chainSynced: boolean | null;
	driftSeconds: number | null;
};

/**
 * Ask the Host how this participant's node is doing.
 *
 * A Host that cannot be reached resolves to ready rather than blocking:
 * refusing an action on a guess is worse than letting the operator try and see
 * a real error.
 */
export async function readParticipantNodeState(localParticipantId: string): Promise<ParticipantNodeState> {
	const participant = await prisma.hydraLocalParticipant.findUnique({
		where: { id: localParticipantId },
		include: { HydraHost: true },
	});
	if (!participant) {
		return { state: 'Unknown', isReady: true, reason: null, chainSynced: null, driftSeconds: null };
	}

	try {
		const health = await fetchHostNodeHealth(
			participant.HydraHost.baseUrl,
			decrypt(participant.HydraHost.encryptedUserToken),
			participant.hostNodeId,
			{ allowInsecureHttp: participant.HydraHost.allowInsecureHttp },
		);
		const chain = { chainSynced: health.chainSynced, driftSeconds: health.driftSeconds };
		if (health.usable) {
			return { state: health.state, isReady: true, reason: null, ...chain };
		}
		if (health.state !== 'Running') {
			return {
				state: health.state,
				isReady: false,
				reason: 'The node is not running. It has to be up before it can post a transaction.',
				...chain,
			};
		}
		if (!health.chainSynced) {
			return {
				state: health.state,
				isReady: false,
				reason: describeCatchingUp(health.driftSeconds),
				...chain,
			};
		}
		return { state: health.state, isReady: false, reason: 'The node is not answering its own API.', ...chain };
	} catch {
		return { state: 'Unknown', isReady: true, reason: null, chainSynced: null, driftSeconds: null };
	}
}

/**
 * How far behind the node is, in words an operator can act on.
 *
 * "Still catching up" reads the same at thirty seconds behind and at fifteen
 * hours, and the two call for opposite responses: wait, or go and fix the node.
 * A head whose node has been offline longer than its unsynced period refuses
 * everything — L2 included — until it catches up, so the size of the gap is the
 * whole decision.
 *
 * A node that has not reached a chain point at all is the third case, and it
 * used to be reported as the second: its slot 0 converts to the moment before
 * the network existed, so a node that had merely just started was described as
 * "1521.4 days behind". That is not a number anyone can act on, and it reads as
 * broken software rather than as a node that needs another few seconds.
 */
function describeCatchingUp(driftSeconds: number | null): string {
	if (hasNoChainPoint(driftSeconds)) {
		return (
			'This node has not started following the chain yet, so it refuses every command. ' +
			'That is normal for the first few minutes after a start. If it lasts longer, restart the node.'
		);
	}
	const behind = driftSeconds === null ? null : formatDriftBehind(driftSeconds);
	if (behind === null) {
		return 'This node is still catching up with the chain, and refuses every command until it has.';
	}
	return `This node is about ${behind} behind the chain, and refuses every command until it catches up.`;
}
