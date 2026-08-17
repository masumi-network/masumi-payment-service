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
 */

import { prisma } from '@masumi/payment-core/db';

/**
 * Delete the unattached local participants a Host node reservation created, and
 * the secret keys they own.
 *
 * Scoped to participants with no head: one that has been bound to a head is not
 * a reservation any more, and removing it would take a live participant with it.
 * Returns how many were released.
 */
export async function releaseReservedParticipants(input: { hydraHostId: string; hostNodeId: string }): Promise<number> {
	return prisma.$transaction(async (tx) => {
		const reserved = await tx.hydraLocalParticipant.findMany({
			where: { hydraHostId: input.hydraHostId, hostNodeId: input.hostNodeId, hydraHeadId: null },
			select: { id: true, hydraSecretKeyId: true },
		});
		if (reserved.length === 0) {
			return 0;
		}

		// Participants first: the key rows are the parents, and the foreign key is
		// `onDelete: Restrict`, so deleting them the other way round fails.
		await tx.hydraLocalParticipant.deleteMany({ where: { id: { in: reserved.map((row) => row.id) } } });
		await tx.hydraSecretKey.deleteMany({ where: { id: { in: reserved.map((row) => row.hydraSecretKeyId) } } });
		return reserved.length;
	});
}
