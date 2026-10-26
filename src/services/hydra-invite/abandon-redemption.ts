/**
 * Giving up on a redemption of someone else's invite that cannot finish.
 *
 * The redemption job and the retry finish what they can, and wait for what they
 * cannot: a node removed by hand, a Host policy that will not change. Waiting
 * holds a node slot, its fuel and the Host itself, so an operator needs a way
 * out. This is it. It is deliberately the operator's call, because the issuer
 * already holds our material and will be left with a head whose peer never joins.
 */
import { HydraInviteRole, HydraInviteStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { decrypt } from '@/utils/security/encryption';
import { removeHostNode } from '@/services/hydra-host/client';
import { nonceLogRef } from './nonce-log-ref';
import { revealInviteNonce } from './invite-secrets';
import { canRemoveReservedHostNode, releaseReservedParticipants } from './release-reservation';
import { LIVE_REDEEMER_STATUSES } from './redemption-store';
import { isHostNodeGone } from '@/services/hydra-host/node-gone';

/**
 * `raced`: the redemption finished or failed first, so nothing was abandoned.
 * `host-refused`: it is abandoned here, but the Host still holds the node, which
 * must then be removed by hand.
 */
export type AbandonOutcome = 'abandoned' | 'raced' | 'host-refused';

export async function abandonRedemption(invite: {
	id: string;
	nonce: string;
	nonceHash?: string | null;
	hydraHostId: string;
	hostNodeId: string;
	HydraHost: { baseUrl: string; encryptedAdminToken: string | null; allowInsecureHttp: boolean };
}): Promise<AbandonOutcome> {
	// The record first: it is what shields the reservation from the sweeps, and
	// the link that would finish the redemption is guarded on this same status,
	// so a finisher that loses this race rolls its head back.
	const failed = await prisma.hydraHeadInvite.updateMany({
		where: {
			id: invite.id,
			role: HydraInviteRole.Redeemer,
			status: { in: [...LIVE_REDEEMER_STATUSES] },
			hydraHeadId: null,
		},
		data: { status: HydraInviteStatus.Failed },
	});
	if (failed.count !== 1) return 'raced';

	if (invite.HydraHost.encryptedAdminToken === null) {
		logger.error(
			`hydra: abandoned redemption ${nonceLogRef(revealInviteNonce(invite))}, but its host has no admin token; ` +
				`node ${invite.hostNodeId} and its peer port must be removed by hand`,
		);
		return 'host-refused';
	}

	// A node a head here claims is serving that head, whatever happened to this
	// redemption, and force would skip the guard that protects it.
	const boundToHead = await prisma.hydraLocalParticipant.count({
		where: { hydraHostId: invite.hydraHostId, hostNodeId: invite.hostNodeId, hydraHeadId: { not: null } },
	});
	if (boundToHead > 0) {
		logger.warn(
			`hydra: abandoned redemption ${nonceLogRef(revealInviteNonce(invite))}; node ${invite.hostNodeId} is kept for its head`,
		);
		return 'abandoned';
	}

	try {
		if (await canRemoveReservedHostNode(invite.hydraHostId, invite.hostNodeId)) {
			try {
				await removeHostNode(
					invite.HydraHost.baseUrl,
					decrypt(invite.HydraHost.encryptedAdminToken),
					invite.hostNodeId,
					{
						force: true,
						allowInsecureHttp: invite.HydraHost.allowInsecureHttp,
					},
				);
			} catch (error) {
				// A node the Host no longer has is the outcome this asks for.
				if (!isHostNodeGone(error)) throw error;
			}
		}
	} catch (error) {
		logger.error(
			`hydra: abandoned redemption ${nonceLogRef(revealInviteNonce(invite))} locally, but its host refused (${(error as Error).message}); ` +
				`node ${invite.hostNodeId} and its peer port must be removed by hand`,
		);
		return 'host-refused';
	}

	try {
		await releaseReservedParticipants({ hydraHostId: invite.hydraHostId, hostNodeId: invite.hostNodeId });
	} catch (error) {
		// The record is already failed, so the abandoned-reservation sweep takes this up.
		logger.warn(
			`hydra: could not release the node of abandoned redemption ${nonceLogRef(revealInviteNonce(invite))}: ${(error as Error).message}`,
		);
	}
	return 'abandoned';
}
