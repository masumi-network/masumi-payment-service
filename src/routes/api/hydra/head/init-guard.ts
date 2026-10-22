/**
 * Process-local guards for POST /hydra/head/init.
 *
 * Split from `lifecycle.ts`, which was past the 750-line limit.
 */

import { HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';

import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { readParticipantNodeState } from '@/services/hydra-host/node-state';

/** Heads with an Init on the wire from this process. */
export const initsInFlight = new Set<string>();
/** Heads whose last Init timed out on a node behind the chain, so that Init may still be parked there. */
export const initsAwaitingNode = new Set<string>();

/**
 * Refuses a retry while an earlier Init may still be parked on the node.
 *
 * An Init that timed out on a node behind the chain may still be parked there, to be
 * posted once the node catches up. A second Init then is refused with a CommandFailed,
 * recorded against a head that is fine. If the first was never sent (our client also
 * waits for a node that is behind), a retry would only wait and time out again.
 */
export async function assertNoParkedInit(hydraHeadId: string, localParticipantId: string): Promise<void> {
	if (!initsAwaitingNode.has(hydraHeadId)) return;
	const nodeState = await readParticipantNodeState(localParticipantId);
	// Only a running node with a reported drift is behind. The Host reads "not synced" with
	// no drift for a node it cannot ask. A node it is stopping or restarting drops an Init
	// still parked on it, while its last drift reading can stay on the record until the next
	// check. An InitTx it already posted is not dropped: init() returns early once the
	// restarted node reports the head Initializing.
	if (nodeState.state === 'Running' && nodeState.chainSynced === false && nodeState.driftSeconds !== null) {
		throw createHttpError(
			409,
			"An earlier Init is still waiting for this head's node: its Hydra Host reports the node is still " +
				'behind the chain. Retry once the Host reports it caught up',
		);
	}
	// A node that just caught up may have posted the parked Init already. Drained first,
	// so a head that moved is refused here rather than by a second Init on the node.
	await getHydraConnectionManager()
		.flushHeadStatus(hydraHeadId)
		.catch(() => undefined);
	const current = await prisma.hydraHead.findUnique({ where: { id: hydraHeadId }, select: { status: true } });
	if (current && current.status !== HydraHeadStatus.Idle) {
		throw createHttpError(409, `Cannot init: head status is ${current.status}, expected Idle`);
	}
	initsAwaitingNode.delete(hydraHeadId);
}
