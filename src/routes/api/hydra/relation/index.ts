import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { Network, HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import {
	quiesceHydraHeadsForDeletion,
	reconciledFinalHeadFilter,
	unsettledL2TransactionWhere,
} from '../deletion-guard';

const hydraRelationSchema = z
	.object({
		id: z.string(),
		createdAt: z.date(),
		updatedAt: z.date(),
		network: z.nativeEnum(Network),
		localHotWalletId: z.string(),
		remoteWalletId: z.string(),
		LocalHotWallet: z
			.object({
				id: z.string(),
				walletVkey: z.string(),
				walletAddress: z.string(),
				type: z.string(),
				note: z.string().nullable(),
			})
			.optional(),
		RemoteWallet: z
			.object({
				id: z.string(),
				walletVkey: z.string(),
				walletAddress: z.string(),
				type: z.string(),
				note: z.string().nullable(),
			})
			.optional(),
		_count: z
			.object({
				Heads: z.number(),
			})
			.optional(),
	})
	.openapi('HydraRelation');

const hydraRelationDetailSchema = hydraRelationSchema
	.extend({
		Heads: z
			.array(
				z.object({
					id: z.string(),
					status: z.nativeEnum(HydraHeadStatus),
					headIdentifier: z.string().nullable(),
					isEnabled: z.boolean(),
					createdAt: z.date(),
					openedAt: z.date().nullable(),
					closedAt: z.date().nullable(),
					finalizedAt: z.date().nullable(),
					_count: z.object({
						RemoteParticipants: z.number(),
					}),
				}),
			)
			.optional(),
	})
	.openapi('HydraRelationDetail');

// --- GET: list or get by ID ---

const getRelationSchemaInput = z.object({
	id: z.string().optional().describe('Get a single relation by ID'),
	network: z.nativeEnum(Network).optional().describe('Filter by Cardano network'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(25).describe('Number of results'),
});

const getRelationSchemaOutput = z.object({
	relations: z.array(hydraRelationDetailSchema),
});

export const getOrListRelationsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getRelationSchemaInput,
	output: getRelationSchemaOutput,
	handler: async ({ input }) => {
		if (input.id) {
			const relation = await prisma.hydraRelation.findUnique({
				where: { id: input.id },
				include: {
					LocalHotWallet: {
						select: { id: true, walletVkey: true, walletAddress: true, type: true, note: true },
					},
					RemoteWallet: {
						select: { id: true, walletVkey: true, walletAddress: true, type: true, note: true },
					},
					Heads: {
						orderBy: { createdAt: 'desc' },
						select: {
							id: true,
							status: true,
							headIdentifier: true,
							isEnabled: true,
							createdAt: true,
							openedAt: true,
							closedAt: true,
							finalizedAt: true,
							_count: { select: { RemoteParticipants: true } },
						},
					},
					_count: { select: { Heads: true } },
				},
			});

			if (!relation) {
				throw createHttpError(404, 'Hydra relation not found');
			}

			return { relations: [relation] };
		}

		const relations = await prisma.hydraRelation.findMany({
			where: {
				...(input.network ? { network: input.network } : {}),
			},
			include: {
				LocalHotWallet: {
					select: { id: true, walletVkey: true, walletAddress: true, type: true, note: true },
				},
				RemoteWallet: {
					select: { id: true, walletVkey: true, walletAddress: true, type: true, note: true },
				},
				_count: { select: { Heads: true } },
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
		});

		return { relations };
	},
});

// --- POST: create relation ---

const createRelationSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('Cardano network for this relation'),
	localHotWalletId: z.string().min(1).describe('HotWallet ID for the local participant'),
	remoteWalletId: z.string().min(1).describe('WalletBase ID for the remote counterparty'),
});

const createRelationSchemaOutput = hydraRelationSchema;

export const createRelationPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createRelationSchemaInput,
	output: createRelationSchemaOutput,
	handler: async ({ input }) => {
		const localWallet = await prisma.hotWallet.findFirst({
			where: { id: input.localHotWalletId, deletedAt: null },
			include: { PaymentSource: true },
		});
		if (!localWallet) {
			throw createHttpError(404, `HotWallet ${input.localHotWalletId} not found`);
		}

		const remoteWallet = await prisma.walletBase.findUnique({
			where: { id: input.remoteWalletId },
			include: { PaymentSource: true },
		});
		if (!remoteWallet) {
			throw createHttpError(404, `WalletBase ${input.remoteWalletId} not found`);
		}

		if (localWallet.PaymentSource.network !== input.network) {
			throw createHttpError(400, 'Local wallet must belong to a payment source on the specified network');
		}

		if (remoteWallet.PaymentSource.network !== input.network) {
			throw createHttpError(400, 'Remote wallet must belong to a payment source on the specified network');
		}

		const existing = await prisma.hydraRelation.findUnique({
			where: {
				network_localHotWalletId_remoteWalletId: {
					network: input.network,
					localHotWalletId: input.localHotWalletId,
					remoteWalletId: input.remoteWalletId,
				},
			},
		});

		if (existing) {
			throw createHttpError(409, 'A relation already exists between these wallets on this network');
		}

		const relation = await prisma.hydraRelation.create({
			data: {
				network: input.network,
				localHotWalletId: input.localHotWalletId,
				remoteWalletId: input.remoteWalletId,
			},
		});

		return relation;
	},
});

// --- DELETE: delete relation ---

const deleteRelationSchemaInput = z.object({
	id: z.string().min(1).describe('ID of the HydraRelation to delete'),
});

const deleteRelationSchemaOutput = z.object({
	id: z.string(),
	deleted: z.boolean(),
});

export const deleteRelationDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteRelationSchemaInput,
	output: deleteRelationSchemaOutput,
	handler: async ({ input }) => {
		await deleteHydraRelation(input.id);
		return { id: input.id, deleted: true };
	},
});

export async function deleteHydraRelation(id: string): Promise<void> {
	const deletionPlan = await prisma.hydraRelation.findUnique({
		where: { id },
		select: { Heads: { select: { id: true } } },
	});
	if (!deletionPlan) throw createHttpError(404, 'Hydra relation not found');
	await quiesceHydraHeadsForDeletion(deletionPlan.Heads.map(({ id: headId }) => headId));

	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (tx) => {
					// Lock the relation first so no new head can acquire its FK while the
					// exact current head set is locked and rechecked for deletion.
					await tx.$queryRaw(Prisma.sql`
						SELECT "id" FROM "HydraRelation" WHERE "id" = ${id} FOR UPDATE
					`);
					await tx.$queryRaw(Prisma.sql`
						SELECT "id"
						FROM "HydraHead"
						WHERE "hydraRelationId" = ${id}
						ORDER BY "id"
						FOR UPDATE
					`);
					const relation = await tx.hydraRelation.findUnique({
						where: { id },
						select: {
							Heads: {
								select: {
									status: true,
									isEnabled: true,
									fanoutTxHash: true,
									reconciliationCompletedAt: true,
									_count: {
										select: {
											Transactions: {
												where: unsettledL2TransactionWhere,
											},
										},
									},
									LocalParticipant: { select: { hydraSecretKeyId: true } },
									RemoteParticipants: { select: { hydraVerificationKeyId: true } },
								},
							},
						},
					});
					if (!relation) throw createHttpError(404, 'Hydra relation not found');

					const unsafeHeadCount = relation.Heads.filter(
						(head) =>
							head.status !== HydraHeadStatus.Final ||
							head.isEnabled ||
							head.fanoutTxHash == null ||
							head.reconciliationCompletedAt == null ||
							head._count.Transactions !== 0,
					).length;
					if (unsafeHeadCount > 0) {
						throw createHttpError(
							409,
							`Cannot delete relation: ${unsafeHeadCount} head(s) have incomplete reconciliation or pending L2 work`,
						);
					}

					const secretKeyIds = relation.Heads.flatMap(({ LocalParticipant }) =>
						LocalParticipant ? [LocalParticipant.hydraSecretKeyId] : [],
					);
					const verificationKeyIds = relation.Heads.flatMap(({ RemoteParticipants }) =>
						RemoteParticipants.map(({ hydraVerificationKeyId }) => hydraVerificationKeyId),
					);
					const deleted = await tx.hydraRelation.deleteMany({
						where: {
							id,
							Heads: { every: reconciledFinalHeadFilter },
						},
					});
					if (deleted.count !== 1) {
						throw createHttpError(409, 'Cannot delete relation: Hydra cleanup eligibility changed concurrently');
					}
					if (secretKeyIds.length > 0) {
						await tx.hydraSecretKey.deleteMany({ where: { id: { in: secretKeyIds } } });
					}
					if (verificationKeyIds.length > 0) {
						await tx.hydraVerificationKey.deleteMany({ where: { id: { in: verificationKeyIds } } });
					}
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: 10_000,
					timeout: 10_000,
				},
			),
		{ label: 'hydra-relation-delete' },
	);
}
