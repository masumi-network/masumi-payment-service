/**
 * Run or pause this service's own node for one head.
 *
 * Disabling a head only stops this service from observing it. The node keeps
 * co-signing snapshots, so the counterparty can still lock funds in the head,
 * and this side never sees those locks. Stopping the node is what tells the
 * counterparty: its node reports the peer as disconnected, and its L2 routing
 * then refuses the head.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { decrypt } from '@/utils/security/encryption';
import { startHostNode, stopHostNode } from './client';

export type OwnNodeRunStateOutcome = 'requested' | 'no-participant' | 'no-admin-token' | 'failed';

/**
 * Ask the Host to run (`running: true`) or stop the local node of this head.
 *
 * Never throws: callers run this beside a durable enable-state change that must
 * stand on its own. Start is idempotent on the Host, so a node that already
 * runs is not restarted.
 */
export async function setOwnHeadNodeRunning(
	hydraHeadId: string,
	running: boolean,
	reason: string,
): Promise<OwnNodeRunStateOutcome> {
	const action = running ? 'start' : 'stop';
	try {
		const participant = await prisma.hydraLocalParticipant.findUnique({
			where: { hydraHeadId },
			select: {
				hostNodeId: true,
				HydraHost: { select: { baseUrl: true, encryptedAdminToken: true, allowInsecureHttp: true } },
			},
		});
		if (!participant) {
			logger.warn('[HydraOwnNode] head has no local participant; node run state unchanged', {
				hydraHeadId,
				action,
				reason,
			});
			return 'no-participant';
		}
		const host = participant.HydraHost;
		if (host.encryptedAdminToken === null) {
			logger.warn('[HydraOwnNode] host has no admin token; cannot change the node run state', {
				hydraHeadId,
				hostNodeId: participant.hostNodeId,
				action,
				reason,
			});
			return 'no-admin-token';
		}
		const call = running ? startHostNode : stopHostNode;
		await call(host.baseUrl, decrypt(host.encryptedAdminToken), participant.hostNodeId, {
			allowInsecureHttp: host.allowInsecureHttp,
		});
		logger.warn(`[HydraOwnNode] requested node ${action}`, {
			hydraHeadId,
			hostNodeId: participant.hostNodeId,
			reason,
		});
		return 'requested';
	} catch (error) {
		logger.error(`[HydraOwnNode] node ${action} request failed`, {
			hydraHeadId,
			reason,
			error: error instanceof Error ? error.message : String(error),
		});
		return 'failed';
	}
}
