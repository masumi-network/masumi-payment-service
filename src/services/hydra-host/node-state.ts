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
 */
function describeCatchingUp(driftSeconds: number | null): string {
	const base = 'The node is running but still catching up on chain, and will reject commands until it has.';
	if (driftSeconds == null || driftSeconds <= 0) return base;
	return `${base} It is ${formatBehind(driftSeconds)} behind.`;
}

/** Rounded to the unit that answers "wait, or intervene?" rather than to the second. */
function formatBehind(seconds: number): string {
	if (seconds < 90) return `${Math.round(seconds)} seconds`;
	const minutes = seconds / 60;
	if (minutes < 90) return `${Math.round(minutes)} minutes`;
	const hours = minutes / 60;
	if (hours < 48) return `${hours.toFixed(1)} hours`;
	return `${(hours / 24).toFixed(1)} days`;
}
