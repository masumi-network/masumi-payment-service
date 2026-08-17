/**
 * Give back what an invite reserved but never used.
 *
 * Issuing an invite reserves a node on a Host and records a local participant
 * for it, whose signing keys are stored encrypted in a `HydraSecretKey` row.
 * When the invite is revoked or expires, the participant goes — and the keys
 * used to stay, because the row they live in is the participant's *parent*: the
 * relation is `HydraLocalParticipant.hydraSecretKeyId -> HydraSecretKey`, so
 * deleting the child deletes nothing on the other side and nothing else ever
 * looks at it again. Every revoked invite left one behind, permanently.
 *
 * Deleting them is not free either. The funding cycle covers a node from the
 * moment it is reserved, so by the time an invite expires its node usually
 * holds 30 ADA at an address whose only signing key is the one about to be
 * deleted — and the Host discloses that key exactly once, at provisioning. So
 * the money is swept back first, and a participant whose balance could not be
 * settled is kept rather than dropped: a reservation that lingers costs a row,
 * where a deleted key costs the ADA behind it.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraInviteStatus } from '@/generated/prisma/client';
import { withdrawNodeFunds } from '@/services/hydra-node-funding/withdraw';

export type ReservationRelease = {
	/** Participants deleted, along with their keys. */
	released: number;
	/** Participants kept because their funds could not be settled. */
	retained: number;
};

/**
 * How long a participant with no head and no invite must have existed before it
 * is treated as abandoned.
 *
 * Redemption creates the participant and binds it to a head in separate steps,
 * so a participant with neither is a normal intermediate state for a moment.
 * Sweeping on age alone would occasionally delete a node in the middle of being
 * adopted.
 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Sweep outcomes after which nothing of value is left behind the node's key.
 *
 * `swept` is deliberately not one of them. A sweep reports success when its
 * transaction is accepted by the submit endpoint, which is not the same as
 * being on chain: it can still be evicted from the mempool, rolled back, or
 * expire against its own TTL. Deleting the key on that evidence is the one
 * mistake here with no recovery, so a swept node keeps its row and is released
 * by a later pass — by which time the chain itself reports the address empty
 * and the outcome is `dust`.
 */
const SETTLED_CODES = new Set(['dust', 'no-key']);

/**
 * Return a reserved node's fuel, and say whether its key may now be destroyed.
 *
 * A failure here is reported as "not settled" rather than thrown: one node
 * whose chain query failed must not stop the rest of a sweep.
 */
async function settleNodeFunds(localParticipantId: string): Promise<boolean> {
	try {
		const outcome = await withdrawNodeFunds(localParticipantId);
		if (outcome.code === 'swept') {
			logger.info(
				`hydra: swept ${outcome.balanceLovelace} lovelace from released node ${localParticipantId} in ${outcome.txHash}`,
			);
		}
		return SETTLED_CODES.has(outcome.code);
	} catch (error) {
		logger.warn(
			`hydra: could not sweep the node of participant ${localParticipantId} before releasing it: ${(error as Error).message}`,
		);
		return false;
	}
}

/**
 * Delete the unattached local participants a Host node reservation created, and
 * the secret keys they own.
 *
 * Scoped to participants with no head: one that has been bound to a head is not
 * a reservation any more, and removing it would take a live participant with it.
 *
 * Call this only once the invite is out of its live statuses — the sweep
 * refuses to move funds while an invite may still need them to post its Init,
 * and a refusal keeps the participant, so an early call releases nothing.
 */
export async function releaseReservedParticipants(input: {
	hydraHostId: string;
	hostNodeId: string;
}): Promise<ReservationRelease> {
	const reserved = await prisma.hydraLocalParticipant.findMany({
		where: { hydraHostId: input.hydraHostId, hostNodeId: input.hostNodeId, hydraHeadId: null },
		select: { id: true, hydraSecretKeyId: true },
	});
	if (reserved.length === 0) {
		return { released: 0, retained: 0 };
	}

	const settled: Array<{ id: string; hydraSecretKeyId: string }> = [];
	let retained = 0;
	for (const participant of reserved) {
		if (await settleNodeFunds(participant.id)) {
			settled.push(participant);
		} else {
			retained += 1;
			logger.warn(
				`hydra: keeping participant ${participant.id}; its node's funds are not settled and its key is the only way to move them`,
			);
		}
	}
	if (settled.length === 0) {
		return { released: 0, retained };
	}

	await prisma.$transaction(async (tx) => {
		// Participants first: the key rows are the parents, and the foreign key is
		// `onDelete: Restrict`, so deleting them the other way round fails.
		await tx.hydraLocalParticipant.deleteMany({ where: { id: { in: settled.map((row) => row.id) } } });
		await tx.hydraSecretKey.deleteMany({ where: { id: { in: settled.map((row) => row.hydraSecretKeyId) } } });
	});
	return { released: settled.length, retained };
}

/**
 * Retry the releases that a failed sweep held back.
 *
 * Without this the retention above is permanent: an expired invite is only
 * reaped once, and a revoke answers and is gone, so a node whose chain query
 * happened to fail at that moment would keep its row and its fuel for good.
 * Everything this finds has already been through one of those paths.
 */
export async function releaseAbandonedReservations(): Promise<ReservationRelease> {
	const liveInvites = await prisma.hydraHeadInvite.findMany({
		where: { status: { in: [HydraInviteStatus.Issued, HydraInviteStatus.Redeemed, HydraInviteStatus.Started] } },
		select: { hydraHostId: true, hostNodeId: true },
	});
	const held = new Set(liveInvites.map((invite) => `${invite.hydraHostId}/${invite.hostNodeId}`));

	const orphans = await prisma.hydraLocalParticipant.findMany({
		where: { hydraHeadId: null, createdAt: { lt: new Date(Date.now() - ORPHAN_MIN_AGE_MS) } },
		select: { hydraHostId: true, hostNodeId: true },
		distinct: ['hydraHostId', 'hostNodeId'],
	});

	const outcome: ReservationRelease = { released: 0, retained: 0 };
	for (const orphan of orphans) {
		if (held.has(`${orphan.hydraHostId}/${orphan.hostNodeId}`)) {
			continue;
		}
		const result = await releaseReservedParticipants(orphan);
		outcome.released += result.released;
		outcome.retained += result.retained;
	}
	return outcome;
}
