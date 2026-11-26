/**
 * Creating a head already bound to its relation and participants.
 *
 * Split from the head route module to keep it under the 750-line limit. This is
 * not an endpoint: the invite orchestrator calls it once an exchange completes,
 * and it owns the serializable transaction that makes a head and its two
 * participants appear together or not at all.
 *
 * Imports the route module rather than being imported by it, so no cycle forms:
 * the include shape and the prior-fanout check are shared with the read paths
 * and stay there.
 */

import { HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { isUniqueConstraintError } from '@masumi/payment-core/db-retry';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import createHttpError from 'http-errors';

import { assertContestationPeriodAllowed } from '@/services/hydra-invite/provisioning';
import { headInclude, verifyPriorHydraFanouts, type HydraHeadRecord } from './index';
import { findPriorHeadBlocker, type PriorHeadBlocker } from './prior-head-blocker';

const PRIOR_HEAD_BLOCKER_MESSAGES: Record<PriorHeadBlocker['kind'], string> = {
	live: 'Hydra relation already has a non-final head',
	unsettled: 'Previous Hydra head fanout is not independently confirmed or its L2 state is not fully adopted',
	handoffs: 'Previous Hydra head still has unadopted fanout handoffs',
};

/**
 * Everything createBoundHydraHead refuses on about earlier heads, asked before
 * anything is spent. The database half returns its reason; the L1 half throws
 * the same 409 or 503 head creation would.
 */
export async function findHeadReplacementBlocker(
	relation: Prisma.HydraRelationWhereInput,
): Promise<PriorHeadBlocker | null> {
	const blocker = await findPriorHeadBlocker(prisma, relation);
	if (blocker !== null) return blocker;
	const relations = await prisma.hydraRelation.findMany({ where: relation, select: { id: true } });
	for (const { id } of relations) await verifyPriorHydraFanouts(id);
	return null;
}

export async function createBoundHydraHead(input: {
	hydraRelationId: string;
	contestationPeriod: bigint;
	localParticipantId: string;
	remoteParticipantId: string;
	/**
	 * Records the invite that produced this head, inside the same transaction.
	 * Without it a crash between the head and the invite write left a head no
	 * invite pointed at, and the next adoption pass revoked the invite.
	 */
	linkInvite?: (tx: Prisma.TransactionClient, hydraHeadId: string) => Promise<void>;
}): Promise<HydraHeadRecord> {
	const verifiedPriorFanouts = await verifyPriorHydraFanouts(input.hydraRelationId);
	try {
		return await withSerializableSlotRetry(
			() =>
				prisma.$transaction(
					async (tx) => {
						const lockedRelation = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
							SELECT "id"
							FROM "HydraRelation"
							WHERE "id" = ${input.hydraRelationId}
							FOR UPDATE
						`);
						if (lockedRelation.length !== 1) {
							throw createHttpError(404, 'Hydra relation not found');
						}
						const relation = await tx.hydraRelation.findUnique({
							where: { id: input.hydraRelationId },
							select: {
								id: true,
								network: true,
								localHotWalletId: true,
								remoteWalletId: true,
							},
						});
						if (!relation) {
							throw createHttpError(404, 'Hydra relation not found');
						}
						if (relation.network !== verifiedPriorFanouts.network) {
							throw createHttpError(409, 'Hydra relation network changed during replacement verification');
						}
						// The same floor the invite path applies before it reserves anything,
						// from the same constant, so the two cannot drift apart.
						assertContestationPeriodAllowed(relation.network, Number(input.contestationPeriod));

						// Serialize replacement with rollback invalidation and fanout
						// adoption. Once these rows are locked, no previous Final head
						// may lose its durable proof while this replacement is created.
						await tx.$queryRaw(Prisma.sql`
							SELECT "id"
							FROM "HydraHead"
							WHERE "hydraRelationId" = ${relation.id}
							ORDER BY "id"
							FOR UPDATE
						`);
						const blocker = await findPriorHeadBlocker(tx, { id: relation.id });
						if (blocker !== null) {
							throw createHttpError(409, PRIOR_HEAD_BLOCKER_MESSAGES[blocker.kind]);
						}

						const priorFinalHeads = await tx.hydraHead.findMany({
							where: {
								hydraRelationId: relation.id,
								status: HydraHeadStatus.Final,
							},
							select: { id: true, fanoutTxHash: true },
						});
						if (
							priorFinalHeads.length !== verifiedPriorFanouts.fanoutTxHashByHeadId.size ||
							priorFinalHeads.some(
								(head) => verifiedPriorFanouts.fanoutTxHashByHeadId.get(head.id) !== head.fanoutTxHash,
							)
						) {
							throw createHttpError(409, 'Previous Hydra head fanout evidence changed during replacement verification');
						}

						const localParticipant = await tx.hydraLocalParticipant.findUnique({
							where: { id: input.localParticipantId },
							select: {
								id: true,
								walletId: true,
								hydraHostId: true,
								hydraHeadId: true,
								Wallet: {
									select: {
										deletedAt: true,
										PaymentSource: { select: { id: true, network: true, deletedAt: true } },
									},
								},
							},
						});
						if (!localParticipant) {
							throw createHttpError(404, `HydraLocalParticipant ${input.localParticipantId} not found`);
						}
						if (localParticipant.hydraHeadId !== null) {
							throw createHttpError(409, 'Local participant is already assigned to a head');
						}
						// The reservation may have started before maintenance. Lock the
						// Host row so a late adoption cannot create a head after the pause
						// sampled its nodes, or while a token is being rotated.
						const hostRows = await tx.$queryRaw<Array<{ pausedAt: Date | null }>>(Prisma.sql`
							SELECT "pausedAt" FROM "HydraHost" WHERE "id" = ${localParticipant.hydraHostId} FOR SHARE
						`);
						if (hostRows.length !== 1 || hostRows[0].pausedAt !== null) {
							throw createHttpError(409, 'the local participant Host is paused; resume it before creating a head');
						}
						if (localParticipant.walletId !== relation.localHotWalletId) {
							throw createHttpError(400, 'Local participant does not belong to the Hydra relation wallet');
						}
						if (
							localParticipant.Wallet.deletedAt !== null ||
							localParticipant.Wallet.PaymentSource.deletedAt !== null
						) {
							throw createHttpError(409, 'Local participant wallet or payment source is inactive');
						}
						if (localParticipant.Wallet.PaymentSource.network !== relation.network) {
							throw createHttpError(400, 'Local participant wallet is on the wrong Cardano network');
						}

						const remoteParticipant = await tx.hydraRemoteParticipant.findUnique({
							where: { id: input.remoteParticipantId },
							select: {
								id: true,
								walletId: true,
								hydraHeadId: true,
								Wallet: {
									select: {
										PaymentSource: { select: { id: true, network: true, deletedAt: true } },
									},
								},
							},
						});
						if (!remoteParticipant) {
							throw createHttpError(404, `HydraRemoteParticipant ${input.remoteParticipantId} not found`);
						}
						if (remoteParticipant.hydraHeadId !== null) {
							throw createHttpError(409, 'Remote participant is already assigned to a head');
						}
						if (remoteParticipant.walletId !== relation.remoteWalletId) {
							throw createHttpError(400, 'Remote participant does not belong to the Hydra relation wallet');
						}
						if (remoteParticipant.Wallet.PaymentSource.deletedAt !== null) {
							throw createHttpError(409, 'Remote participant payment source is inactive');
						}
						if (remoteParticipant.Wallet.PaymentSource.network !== relation.network) {
							throw createHttpError(400, 'Remote participant wallet is on the wrong Cardano network');
						}
						if (remoteParticipant.Wallet.PaymentSource.id !== localParticipant.Wallet.PaymentSource.id) {
							throw createHttpError(400, 'Hydra relation wallets must belong to the same payment source');
						}

						const head = await tx.hydraHead.create({
							data: {
								hydraRelationId: relation.id,
								contestationPeriod: input.contestationPeriod,
							},
							select: { id: true },
						});

						const localClaim = await tx.hydraLocalParticipant.updateMany({
							where: {
								id: localParticipant.id,
								walletId: relation.localHotWalletId,
								hydraHeadId: null,
							},
							data: { hydraHeadId: head.id },
						});
						if (localClaim.count !== 1) {
							throw createHttpError(409, 'Local participant was concurrently assigned to another head');
						}

						const remoteClaim = await tx.hydraRemoteParticipant.updateMany({
							where: {
								id: remoteParticipant.id,
								walletId: relation.remoteWalletId,
								hydraHeadId: null,
							},
							data: { hydraHeadId: head.id },
						});
						if (remoteClaim.count !== 1) {
							throw createHttpError(409, 'Remote participant was concurrently assigned to another head');
						}
						await input.linkInvite?.(tx, head.id);

						return await tx.hydraHead.findUniqueOrThrow({
							where: { id: head.id },
							include: headInclude,
						});
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 10_000,
						timeout: 10_000,
					},
				),
			{ label: 'hydra-head-create' },
		);
	} catch (error) {
		if (createHttpError.isHttpError(error)) {
			throw error;
		}
		if (isUniqueConstraintError(error)) {
			throw createHttpError(409, 'Hydra relation or participant was concurrently assigned to another head');
		}
		throw error;
	}
}
