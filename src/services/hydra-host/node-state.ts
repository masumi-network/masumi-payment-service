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
		return { state: 'Unknown', isReady: true, reason: null };
	}

	try {
		const health = await fetchHostNodeHealth(
			participant.HydraHost.baseUrl,
			decrypt(participant.HydraHost.encryptedUserToken),
			participant.hostNodeId,
		);
		if (health.usable) {
			return { state: health.state, isReady: true, reason: null };
		}
		if (health.state !== 'Running') {
			return {
				state: health.state,
				isReady: false,
				reason: 'The node is not running. It has to be up before it can post a transaction.',
			};
		}
		if (!health.chainSynced) {
			return {
				state: health.state,
				isReady: false,
				reason: 'The node is running but still catching up on chain, and will reject commands until it has.',
			};
		}
		return { state: health.state, isReady: false, reason: 'The node is not answering its own API.' };
	} catch {
		return { state: 'Unknown', isReady: true, reason: null };
	}
}
