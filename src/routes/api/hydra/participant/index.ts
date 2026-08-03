import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import { fundHydraNodeNow, readNodeFundingState } from '@/services/hydra-node-funding/service';
import { withdrawNodeFunds } from '@/services/hydra-node-funding/withdraw';
import { readParticipantNodeState } from '@/services/hydra-host/node-state';
import { decrypt } from '@/utils/security/encryption';
import createHttpError from 'http-errors';
import { HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import {
	quiesceHydraHeadsForDeletion,
	reconciledFinalHeadFilter,
	unsettledL2TransactionWhere,
} from '../deletion-guard';

// --- Shared schemas ---

export const localParticipantSchema = z
	.object({
		id: z.string(),
		createdAt: z.date(),
		updatedAt: z.date(),
		hydraHeadId: z.string().nullable(),
		walletId: z.string(),
		cardanoVkey: z.string(),
		nodeUrl: z.string(),
		nodeHttpUrl: z.string(),
		hasCommitted: z.boolean(),
		commitTxHash: z.string().nullable(),
		/** Which connected node runs this participant's hydra-node process. */
		hydraHostId: z.string(),
		hostNodeId: z.string(),
		/** Null until an operator has taken a one-time backup of the node's signing keys. */
		keysDisclosedAt: z.date().nullable(),
	})
	.openapi('HydraLocalParticipant');

export const remoteParticipantSchema = z
	.object({
		id: z.string(),
		createdAt: z.date(),
		updatedAt: z.date(),
		hydraHeadId: z.string().nullable(),
		walletId: z.string(),
		cardanoVkey: z.string(),
		/** Peer-plane `host:port`, as the counterparty advertised it. Not an API URL. */
		advertise: z.string(),
		hasCommitted: z.boolean(),
		commitTxHash: z.string().nullable(),
		hydraVerificationKeyId: z.string(),
	})
	.openapi('HydraRemoteParticipant');

// ============================================================
// LOCAL PARTICIPANT ENDPOINTS
//
// Read and delete only. Participants are created by the cross-organisation
// handshake, which provisions the node on a Hydra Host and takes the
// counterparty's identity from material they signed — there is no way to
// declare one by hand.
// ============================================================

export const getLocalParticipantInput = z.object({
	id: z.string().optional().describe('Get a single participant by ID'),
	walletId: z.string().optional().describe('Filter by HotWallet ID'),
	hydraHostId: z.string().optional().describe('Filter by the connected node running them'),
	unassigned: z
		.string()
		.optional()
		.transform((s) => (s === undefined ? undefined : s.toLowerCase() === 'true'))
		.describe('Filter to only unassigned participants (no head)'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(25).describe('Number of results'),
});

export const getLocalParticipantOutput = z.object({
	participants: z.array(localParticipantSchema),
});

export const getLocalParticipantGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getLocalParticipantInput,
	output: getLocalParticipantOutput,
	handler: async ({ input }) => {
		if (input.id) {
			const participant = await prisma.hydraLocalParticipant.findUnique({
				where: { id: input.id },
			});
			if (!participant) {
				throw createHttpError(404, 'Local participant not found');
			}
			return { participants: [participant] };
		}

		const participants = await prisma.hydraLocalParticipant.findMany({
			where: {
				...(input.walletId ? { walletId: input.walletId } : {}),
				...(input.hydraHostId ? { hydraHostId: input.hydraHostId } : {}),
				...(input.unassigned === true ? { hydraHeadId: null } : {}),
				...(input.unassigned === false ? { hydraHeadId: { not: null } } : {}),
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			...(input.cursorId ? { skip: 1 } : {}),
		});

		return { participants };
	},
});

// --- DELETE: delete local participant ---

export const deleteLocalParticipantInput = z.object({
	id: z.string().min(1).describe('ID of the local participant to delete'),
});

export const deleteLocalParticipantOutput = z.object({
	id: z.string(),
	deleted: z.boolean(),
});

export const deleteLocalParticipantDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteLocalParticipantInput,
	output: deleteLocalParticipantOutput,
	handler: async ({ input }) => {
		await deleteHydraLocalParticipant(input.id);
		return { id: input.id, deleted: true };
	},
});

export async function deleteHydraLocalParticipant(id: string): Promise<void> {
	const deletionPlan = await prisma.hydraLocalParticipant.findUnique({
		where: { id },
		select: {
			hydraHeadId: true,
			HydraHead: { select: { hydraRelationId: true } },
		},
	});
	if (!deletionPlan) throw createHttpError(404, 'Local participant not found');
	if ((deletionPlan.hydraHeadId == null) !== (deletionPlan.HydraHead == null)) {
		throw createHttpError(409, 'Cannot delete: participant head relation is inconsistent');
	}
	if (deletionPlan.hydraHeadId) await quiesceHydraHeadsForDeletion([deletionPlan.hydraHeadId]);

	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (tx) => {
					if (deletionPlan.HydraHead) {
						// Rollback persistence, replacement creation and relation deletion
						// all lock the relation before its heads. Join that order before
						// consuming a Final marker so a rollback already invalidating the
						// relation cannot lose a race to participant/key deletion.
						const lockedRelations = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
							SELECT "id"
							FROM "HydraRelation"
							WHERE "id" = ${deletionPlan.HydraHead.hydraRelationId}
							FOR UPDATE
						`);
						if (lockedRelations.length !== 1) {
							throw createHttpError(409, 'Cannot delete: participant Hydra relation changed concurrently');
						}
					}
					await tx.$queryRaw(Prisma.sql`
							SELECT "id" FROM "HydraLocalParticipant" WHERE "id" = ${id} FOR UPDATE
						`);
					let participant = await tx.hydraLocalParticipant.findUnique({
						where: { id },
						select: {
							hydraHeadId: true,
							hydraSecretKeyId: true,
							HydraHead: {
								select: {
									status: true,
									isEnabled: true,
									fanoutTxHash: true,
									reconciliationCompletedAt: true,
									_count: {
										select: { Transactions: { where: unsettledL2TransactionWhere } },
									},
								},
							},
						},
					});
					if (!participant) throw createHttpError(404, 'Local participant not found');
					if (participant.hydraHeadId !== deletionPlan.hydraHeadId) {
						throw createHttpError(409, 'Cannot delete: participant head assignment changed concurrently');
					}
					if (participant.hydraHeadId) {
						const lockedHeads = await tx.$queryRaw<Array<{ id: string; hydraRelationId: string }>>(Prisma.sql`
							SELECT "id", "hydraRelationId"
							FROM "HydraHead"
							WHERE "id" = ${participant.hydraHeadId}
							FOR UPDATE
						`);
						if (
							lockedHeads.length !== 1 ||
							lockedHeads[0]?.hydraRelationId !== deletionPlan.HydraHead?.hydraRelationId
						) {
							throw createHttpError(409, 'Cannot delete: participant Hydra head changed concurrently');
						}
						participant = await tx.hydraLocalParticipant.findUnique({
							where: { id },
							select: {
								hydraHeadId: true,
								hydraSecretKeyId: true,
								HydraHead: {
									select: {
										status: true,
										isEnabled: true,
										fanoutTxHash: true,
										reconciliationCompletedAt: true,
										_count: {
											select: { Transactions: { where: unsettledL2TransactionWhere } },
										},
									},
								},
							},
						});
						if (!participant) throw createHttpError(404, 'Local participant not found');
						if (participant.hydraHeadId !== deletionPlan.hydraHeadId) {
							throw createHttpError(409, 'Cannot delete: participant head assignment changed concurrently');
						}
					}
					if (
						participant.HydraHead &&
						(participant.HydraHead.status !== HydraHeadStatus.Final ||
							participant.HydraHead.isEnabled ||
							participant.HydraHead.fanoutTxHash == null ||
							participant.HydraHead.reconciliationCompletedAt == null ||
							participant.HydraHead._count.Transactions !== 0)
					) {
						throw createHttpError(409, 'Cannot delete: participant head cleanup is not complete');
					}

					const deleted = await tx.hydraLocalParticipant.deleteMany({
						where: {
							id,
							OR: [{ hydraHeadId: null }, { HydraHead: { is: reconciledFinalHeadFilter } }],
						},
					});
					if (deleted.count !== 1) {
						throw createHttpError(409, 'Cannot delete: participant cleanup eligibility changed concurrently');
					}
					await tx.hydraSecretKey.delete({ where: { id: participant.hydraSecretKeyId } });
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: 10_000,
					timeout: 10_000,
				},
			),
		{ label: 'hydra-local-participant-delete' },
	);
}

// ============================================================
// REMOTE PARTICIPANT ENDPOINTS
// ============================================================

export const getRemoteParticipantInput = z.object({
	id: z.string().optional().describe('Get a single participant by ID'),
	walletId: z.string().optional().describe('Filter by WalletBase ID'),
	unassigned: z
		.string()
		.optional()
		.transform((s) => (s === undefined ? undefined : s.toLowerCase() === 'true'))
		.describe('Filter to only unassigned participants (no head)'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(25).describe('Number of results'),
});

export const getRemoteParticipantOutput = z.object({
	participants: z.array(remoteParticipantSchema),
});

export const getRemoteParticipantGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getRemoteParticipantInput,
	output: getRemoteParticipantOutput,
	handler: async ({ input }) => {
		if (input.id) {
			const participant = await prisma.hydraRemoteParticipant.findUnique({
				where: { id: input.id },
			});
			if (!participant) {
				throw createHttpError(404, 'Remote participant not found');
			}
			return { participants: [participant] };
		}

		const participants = await prisma.hydraRemoteParticipant.findMany({
			where: {
				...(input.walletId ? { walletId: input.walletId } : {}),
				...(input.hydraHostId ? { hydraHostId: input.hydraHostId } : {}),
				...(input.unassigned === true ? { hydraHeadId: null } : {}),
				...(input.unassigned === false ? { hydraHeadId: { not: null } } : {}),
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			...(input.cursorId ? { skip: 1 } : {}),
		});

		return { participants };
	},
});

// --- DELETE: delete remote participant ---

export const deleteRemoteParticipantInput = z.object({
	id: z.string().min(1).describe('ID of the remote participant to delete'),
});

export const deleteRemoteParticipantOutput = z.object({
	id: z.string(),
	deleted: z.boolean(),
});

export const deleteRemoteParticipantDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteRemoteParticipantInput,
	output: deleteRemoteParticipantOutput,
	handler: async ({ input }) => {
		await deleteHydraRemoteParticipant(input.id);
		return { id: input.id, deleted: true };
	},
});

export async function deleteHydraRemoteParticipant(id: string): Promise<void> {
	const deletionPlan = await prisma.hydraRemoteParticipant.findUnique({
		where: { id },
		select: {
			hydraHeadId: true,
			HydraHead: { select: { hydraRelationId: true } },
		},
	});
	if (!deletionPlan) throw createHttpError(404, 'Remote participant not found');
	if ((deletionPlan.hydraHeadId == null) !== (deletionPlan.HydraHead == null)) {
		throw createHttpError(409, 'Cannot delete: participant head relation is inconsistent');
	}
	if (deletionPlan.hydraHeadId) await quiesceHydraHeadsForDeletion([deletionPlan.hydraHeadId]);

	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (tx) => {
					if (deletionPlan.HydraHead) {
						// Serialize destructive key cleanup with authenticated rollback
						// invalidation using the relation-first lock order shared by every
						// other Hydra lifecycle writer.
						const lockedRelations = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
							SELECT "id"
							FROM "HydraRelation"
							WHERE "id" = ${deletionPlan.HydraHead.hydraRelationId}
							FOR UPDATE
						`);
						if (lockedRelations.length !== 1) {
							throw createHttpError(409, 'Cannot delete: participant Hydra relation changed concurrently');
						}
					}
					await tx.$queryRaw(Prisma.sql`
							SELECT "id" FROM "HydraRemoteParticipant" WHERE "id" = ${id} FOR UPDATE
						`);
					let participant = await tx.hydraRemoteParticipant.findUnique({
						where: { id },
						select: {
							hydraHeadId: true,
							hydraVerificationKeyId: true,
							HydraHead: {
								select: {
									status: true,
									isEnabled: true,
									fanoutTxHash: true,
									reconciliationCompletedAt: true,
									_count: {
										select: { Transactions: { where: unsettledL2TransactionWhere } },
									},
								},
							},
						},
					});
					if (!participant) throw createHttpError(404, 'Remote participant not found');
					if (participant.hydraHeadId !== deletionPlan.hydraHeadId) {
						throw createHttpError(409, 'Cannot delete: participant head assignment changed concurrently');
					}
					if (participant.hydraHeadId) {
						const lockedHeads = await tx.$queryRaw<Array<{ id: string; hydraRelationId: string }>>(Prisma.sql`
							SELECT "id", "hydraRelationId"
							FROM "HydraHead"
							WHERE "id" = ${participant.hydraHeadId}
							FOR UPDATE
						`);
						if (
							lockedHeads.length !== 1 ||
							lockedHeads[0]?.hydraRelationId !== deletionPlan.HydraHead?.hydraRelationId
						) {
							throw createHttpError(409, 'Cannot delete: participant Hydra head changed concurrently');
						}
						participant = await tx.hydraRemoteParticipant.findUnique({
							where: { id },
							select: {
								hydraHeadId: true,
								hydraVerificationKeyId: true,
								HydraHead: {
									select: {
										status: true,
										isEnabled: true,
										fanoutTxHash: true,
										reconciliationCompletedAt: true,
										_count: {
											select: { Transactions: { where: unsettledL2TransactionWhere } },
										},
									},
								},
							},
						});
						if (!participant) throw createHttpError(404, 'Remote participant not found');
						if (participant.hydraHeadId !== deletionPlan.hydraHeadId) {
							throw createHttpError(409, 'Cannot delete: participant head assignment changed concurrently');
						}
					}
					if (
						participant.HydraHead &&
						(participant.HydraHead.status !== HydraHeadStatus.Final ||
							participant.HydraHead.isEnabled ||
							participant.HydraHead.fanoutTxHash == null ||
							participant.HydraHead.reconciliationCompletedAt == null ||
							participant.HydraHead._count.Transactions !== 0)
					) {
						throw createHttpError(409, 'Cannot delete: participant head cleanup is not complete');
					}

					const deleted = await tx.hydraRemoteParticipant.deleteMany({
						where: {
							id,
							OR: [{ hydraHeadId: null }, { HydraHead: { is: reconciledFinalHeadFilter } }],
						},
					});
					if (deleted.count !== 1) {
						throw createHttpError(409, 'Cannot delete: participant cleanup eligibility changed concurrently');
					}
					await tx.hydraVerificationKey.delete({ where: { id: participant.hydraVerificationKeyId } });
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: 10_000,
					timeout: 10_000,
				},
			),
		{ label: 'hydra-remote-participant-delete' },
	);
}

// ============================================================
// ONE-TIME KEY BACKUP
// ============================================================

export const revealParticipantKeysInput = z.object({
	id: z.string().min(1).describe('ID of the local participant whose node keys to back up'),
});

export const revealParticipantKeysOutput = z.object({
	id: z.string(),
	disclosedAt: z.string(),
	hydraSigningKey: z.string().describe('Text-envelope cborHex of the node Hydra signing key'),
	cardanoSigningKey: z
		.string()
		.nullable()
		.describe(
			'Text-envelope cborHex of the node Cardano signing key. Null for nodes provisioned before it was captured.',
		),
});

/**
 * Hand a node's signing keys to an operator, exactly once.
 *
 * The keys are generated by the Hydra Host and disclosed by it a single time, at
 * provisioning; this service keeps the only other copy. An operator who wants an
 * off-site backup therefore has to get it from here — but a database copy that
 * any admin call can print on demand is a far worse secret than one that leaves
 * exactly once, so this seals itself the same way the Host's escrow does.
 *
 * Sealing before returning, not after: a caller that receives the keys and
 * crashes has still seen them, and re-opening the path on the strength of a lost
 * response would make "once" meaningless. The stamp is written in the same
 * update that reads the row, so two concurrent calls cannot both win.
 */
export const revealParticipantKeysPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: revealParticipantKeysInput,
	output: revealParticipantKeysOutput,
	handler: async ({ input, logger }) => {
		const disclosed = await prisma.$transaction(
			async (tx) => {
				const rows = await tx.$queryRaw<Array<{ id: string; keysDisclosedAt: Date | null }>>(Prisma.sql`
					SELECT "id", "keysDisclosedAt"
					FROM "HydraLocalParticipant"
					WHERE "id" = ${input.id}
					FOR UPDATE
				`);
				if (rows.length !== 1) {
					throw createHttpError(404, 'Local participant not found');
				}
				if (rows[0].keysDisclosedAt !== null) {
					throw createHttpError(
						409,
						'these keys have already been handed out once; the disclosure path is sealed. Recover the backup you took, or replace the node',
					);
				}

				const participant = await tx.hydraLocalParticipant.update({
					where: { id: input.id },
					data: { keysDisclosedAt: new Date() },
					select: {
						id: true,
						keysDisclosedAt: true,
						HydraSecretKey: { select: { hydraSK: true, cardanoSK: true } },
					},
				});
				return participant;
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 10_000 },
		);

		// Deliberately loud: a one-time disclosure of key material is exactly the
		// event an operator wants to find in the log afterwards.
		logger.warn(`Hydra node signing keys disclosed for participant ${disclosed.id}`);

		return {
			id: disclosed.id,
			disclosedAt: (disclosed.keysDisclosedAt ?? new Date()).toISOString(),
			hydraSigningKey: decrypt(disclosed.HydraSecretKey.hydraSK),
			cardanoSigningKey:
				disclosed.HydraSecretKey.cardanoSK === null ? null : decrypt(disclosed.HydraSecretKey.cardanoSK),
		};
	},
});

// --- POST: fund this node's Cardano key ---

export const fundParticipantNodeInput = z.object({
	id: z.string().min(1).describe('Local participant whose node should be funded'),
});

export const fundParticipantNodeOutput = z.object({
	address: z.string().describe("The node's own Cardano address, derived from its key hash"),
	balanceLovelace: z.string(),
	transferredLovelace: z.string().nullable().describe('Null when the node already had enough'),
});

// --- GET: is this node funded enough to act on chain? ---

export const participantFundingSchemaInput = z.object({ id: z.string().min(1) });

export const participantFundingSchemaOutput = z.object({
	address: z.string(),
	balanceLovelace: z.string(),
	isUnderfunded: z.boolean(),
	shortfallLovelace: z.string(),
	checked: z.boolean().describe('False when the chain could not be consulted — unknown, not zero'),
	/**
	 * Whether the node can be driven right now.
	 *
	 * Provisioned is not the same as ready: a node has to start and catch up on
	 * chain first, and an L1 action attempted in that window fails as
	 * "unreachable", which names the symptom rather than the cause.
	 */
	node: z.object({
		state: z.string(),
		isReady: z.boolean(),
		reason: z.string().nullable().describe('Why it is not ready, when it is not'),
	}),
});

/**
 * Read before an L1 action rather than after it fails.
 *
 * Init that fails for want of funds fails slowly and says nothing about money:
 * the node posts nothing, the service waits out its timeout, and the operator
 * sees a gateway timeout. Asking first turns that into a sentence with a number
 * in it.
 */
export const participantFundingGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: participantFundingSchemaInput,
	output: participantFundingSchemaOutput,
	handler: async ({ input }) => {
		const [state, node] = await Promise.all([readNodeFundingState(input.id), readParticipantNodeState(input.id)]);
		return {
			address: state.address,
			balanceLovelace: state.balanceLovelace.toString(),
			isUnderfunded: state.isUnderfunded,
			shortfallLovelace: state.shortfallLovelace.toString(),
			checked: state.checked,
			node,
		};
	},
});

/**
 * Top up the node's Cardano key now, rather than waiting for the funding cycle.
 *
 * A node cannot open a head from an empty address: Init consumes a seed UTxO
 * there and pays its fee from the same key, so a freshly provisioned node fails
 * with `NoSeedInput`. The scheduled cycle covers this, but the wait is worst on
 * the first head an operator opens — when the failure is least legible and the
 * fix is invisible.
 *
 * Queues a transfer rather than performing one: the existing fund-transfer
 * lifecycle owns building, signing, submitting and confirming, and duplicating
 * that here would mean a second path to get wrong.
 */
export const fundParticipantNodePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: fundParticipantNodeInput,
	output: fundParticipantNodeOutput,
	handler: async ({ input }) => {
		return await fundHydraNodeNow(input.id);
	},
});

// --- POST: return this node's remaining fuel to its wallet ---

export const withdrawParticipantNodeInput = z.object({
	id: z.string().min(1).describe('Local participant whose node should be swept'),
});

export const withdrawParticipantNodeOutput = z.object({
	address: z.string(),
	balanceLovelace: z.string(),
	txHash: z.string().nullable(),
	reason: z.string().nullable().describe('Why nothing was swept, when nothing was'),
});

/**
 * Sweep what a finished node did not spend back to the wallet that funded it.
 *
 * A node serves exactly one head and is never reused, so without this every
 * head permanently strands its unspent fuel — a leak rather than an
 * untidiness at any volume.
 *
 * Refused while the head is live. The node still owes a Close, possibly a
 * Contest and a Fanout, and one that cannot pay for its Fanout leaves the
 * committed funds behind a contestation deadline — much worse than leaving a
 * few ADA behind.
 */
export const withdrawParticipantNodePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: withdrawParticipantNodeInput,
	output: withdrawParticipantNodeOutput,
	handler: async ({ input }) => {
		return await withdrawNodeFunds(input.id);
	},
});
