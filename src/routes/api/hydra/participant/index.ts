import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { encrypt } from '@/utils/security/encryption';
import { getHydraPlaintextHosts, validateHydraNodeUrls } from '@/lib/hydra';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import {
	quiesceHydraHeadsForDeletion,
	reconciledFinalHeadFilter,
	unsettledL2TransactionWhere,
} from '../deletion-guard';
import {
	normalizeHydraSigningKeyCborHex,
	normalizeHydraVerificationKeyCborHex,
} from '@/lib/hydra/hydra/snapshot-verification';

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
		nodeUrl: z.string(),
		nodeHttpUrl: z.string(),
		hasCommitted: z.boolean(),
		commitTxHash: z.string().nullable(),
		hydraVerificationKeyId: z.string(),
	})
	.openapi('HydraRemoteParticipant');

// ============================================================
// LOCAL PARTICIPANT ENDPOINTS
// ============================================================

// --- POST: create local participant ---

export const createLocalParticipantInput = z.object({
	walletId: z.string().min(1).describe('HotWallet ID for the local participant (funding wallet)'),
	nodeUrl: z.string().min(1).describe('WebSocket URL for the local Hydra node'),
	nodeHttpUrl: z.string().min(1).describe('HTTP URL for the local Hydra node'),
	hydraSK: z.string().min(1).describe('Hydra signing key (will be encrypted)'),
	cardanoVkey: z
		.string()
		.regex(/^[0-9a-fA-F]{56}$/)
		.optional()
		.describe(
			"The Hydra node's own Cardano verification-key HASH (28-byte hex) — the on-chain participant identity. Omit to reuse the funding wallet's vkey (legacy coupled behaviour).",
		),
});

export const createLocalParticipantOutput = z.object({
	participant: localParticipantSchema,
});

export const createLocalParticipantPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createLocalParticipantInput,
	output: createLocalParticipantOutput,
	handler: async ({ input }) => {
		const nodeUrls = validateParticipantNodeUrls(input.nodeHttpUrl, input.nodeUrl);
		let hydraSigningKey: string;
		try {
			hydraSigningKey = normalizeHydraSigningKeyCborHex(input.hydraSK);
		} catch {
			throw createHttpError(400, 'hydraSK must be a Hydra Ed25519 signing key or text envelope');
		}
		const wallet = await prisma.hotWallet.findFirst({
			where: { id: input.walletId, deletedAt: null },
		});
		if (!wallet) {
			throw createHttpError(404, `HotWallet ${input.walletId} not found`);
		}

		const participant = await prisma.hydraLocalParticipant.create({
			data: {
				Wallet: { connect: { id: input.walletId } },
				// Node's own on-chain identity; defaults to the funding wallet's vkey
				// only when the caller opts into the legacy coupled model.
				cardanoVkey: (input.cardanoVkey ?? wallet.walletVkey).toLowerCase(),
				nodeUrl: nodeUrls.wsUrl,
				nodeHttpUrl: nodeUrls.httpUrl,
				HydraSecretKey: {
					create: {
						hydraSK: encrypt(hydraSigningKey),
					},
				},
			},
		});

		return { participant };
	},
});

// --- GET: list or get local participants ---

export const getLocalParticipantInput = z.object({
	id: z.string().optional().describe('Get a single participant by ID'),
	walletId: z.string().optional().describe('Filter by HotWallet ID'),
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

// --- POST: create remote participant ---

export const createRemoteParticipantInput = z.object({
	walletId: z.string().min(1).describe('WalletBase ID for the remote counterparty (funding wallet)'),
	nodeUrl: z.string().min(1).describe('WebSocket URL for the remote Hydra node'),
	nodeHttpUrl: z.string().min(1).describe('HTTP URL for the remote Hydra node'),
	hydraVK: z.string().min(1).describe('Hydra verification key (cborHex)'),
	cardanoVkey: z
		.string()
		.regex(/^[0-9a-fA-F]{56}$/)
		.optional()
		.describe(
			"The remote Hydra node's own Cardano verification-key HASH (28-byte hex) — the on-chain participant identity. Omit to reuse the counterparty wallet's vkey (legacy coupled behaviour).",
		),
});

export const createRemoteParticipantOutput = z.object({
	participant: remoteParticipantSchema,
});

export const createRemoteParticipantPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createRemoteParticipantInput,
	output: createRemoteParticipantOutput,
	handler: async ({ input }) => {
		const nodeUrls = validateParticipantNodeUrls(input.nodeHttpUrl, input.nodeUrl);
		let hydraVerificationKey: string;
		try {
			hydraVerificationKey = normalizeHydraVerificationKeyCborHex(input.hydraVK);
		} catch {
			throw createHttpError(400, 'hydraVK must be a Hydra Ed25519 verification key or text envelope');
		}
		const wallet = await prisma.walletBase.findUnique({
			where: { id: input.walletId },
		});
		if (!wallet) {
			throw createHttpError(404, `WalletBase ${input.walletId} not found`);
		}

		const participant = await prisma.hydraRemoteParticipant.create({
			data: {
				Wallet: { connect: { id: input.walletId } },
				cardanoVkey: (input.cardanoVkey ?? wallet.walletVkey).toLowerCase(),
				nodeUrl: nodeUrls.wsUrl,
				nodeHttpUrl: nodeUrls.httpUrl,
				HydraVerificationKey: {
					create: { hydraVK: hydraVerificationKey },
				},
			},
		});

		return { participant };
	},
});

// --- GET: list or get remote participants ---

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

function validateParticipantNodeUrls(nodeHttpUrl: string, nodeUrl: string) {
	try {
		return validateHydraNodeUrls(nodeHttpUrl, nodeUrl, {
			plaintextHosts: getHydraPlaintextHosts(),
		});
	} catch (error) {
		throw createHttpError(400, error instanceof Error ? error.message : 'Invalid Hydra node URLs');
	}
}
