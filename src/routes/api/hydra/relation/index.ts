import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { withdrawNodeFunds } from '@/services/hydra-node-funding/withdraw';
import { Network, HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import {
	quiesceHydraHeadsForDeletion,
	assertNoUnrecoveredHydraDeposits,
	reconciledFinalHeadFilter,
	unrecoveredHydraTopupWhere,
	unsettledL2TransactionWhere,
} from '../deletion-guard';

export const hydraRelationSchema = z
	.object({
		id: z.string(),
		createdAt: z.date(),
		updatedAt: z.date(),
		network: z.nativeEnum(Network),
		localHotWalletId: z.string(),
		remoteWalletId: z.string(),
		/** Where head offers are delivered. */
		counterpartyBaseUrl: z.string().nullable(),
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

export const hydraRelationDetailSchema = hydraRelationSchema
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

export const getRelationSchemaInput = z.object({
	id: z.string().optional().describe('Get a single relation by ID'),
	network: z.nativeEnum(Network).optional().describe('Filter by Cardano network'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(25).describe('Number of results'),
});

export const getRelationSchemaOutput = z.object({
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

// A Relation is no longer something an operator types. It is produced by a
// redeemed Head Invite, which is the only path that can know the counterparty's
// wallet and Exchange Plane URL — both derived from a signature rather than
// from a form. See ADR 0011.

export const deleteRelationSchemaInput = z.object({
	id: z.string().min(1).describe('ID of the HydraRelation to delete'),
});

export const deleteRelationSchemaOutput = z.object({
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

/**
 * Take each node's fuel back before the keys that can sign for it are deleted.
 *
 * Deleting a relation cascades away its heads and their local participants, and
 * deletes those participants' `HydraSecretKey` rows with them. That key's
 * `cardanoSK` is the only signer for the node's L1 address, the Host discloses
 * it exactly once at provisioning, and the funding cycle has been topping that
 * address up since the node was reserved — so a head that has run for any time
 * leaves about 30 ADA there. Deleting the relation took the key and left the ADA
 * at an address nothing can sign for, once per head, with no warning.
 *
 * The participant endpoint has swept before deleting since it was written; this
 * path was the one that did not. Same rule as there: `swept` is not enough,
 * because a submitted sweep can still be evicted or rolled back, so only an
 * address the chain reports as empty — `dust` — or a participant with no key
 * settles it.
 *
 * Outside the transaction, and before quiesce, on purpose: this reads the chain
 * and may submit, neither of which belongs inside a serializable block, and a
 * refusal should land before anything has been disabled.
 */
async function sweepRelationNodeFunds(heads: Array<{ LocalParticipant: { id: string } | null }>): Promise<void> {
	for (const { LocalParticipant } of heads) {
		if (!LocalParticipant) continue;
		const sweep = await withdrawNodeFunds(LocalParticipant.id);
		if (sweep.code === 'dust' || sweep.code === 'no-key') continue;
		// Named only when there is one: several refusal codes report a zero
		// balance, so the funds are not the reason the sweep did not happen.
		const held =
			sweep.balanceLovelace !== '0' ? ` It still holds ${sweep.balanceLovelace} lovelace at ${sweep.address}.` : '';
		throw createHttpError(
			409,
			sweep.txHash
				? `Cannot delete this relation yet.${held} A sweep of its node funds (${sweep.txHash}) has been submitted; ` +
						`try again once it has confirmed`
				: `Cannot delete this relation: ${sweep.reason}.${held}`,
		);
	}
}

export async function deleteHydraRelation(id: string): Promise<void> {
	const deletionPlan = await prisma.hydraRelation.findUnique({
		where: { id },
		select: { Heads: { select: { id: true, LocalParticipant: { select: { id: true } } } } },
	});
	if (!deletionPlan) throw createHttpError(404, 'Hydra relation not found');
	// Before quiesce, which disconnects the heads a recovery would need.
	await assertNoUnrecoveredHydraDeposits(deletionPlan.Heads.map(({ id: headId }) => headId));
	await sweepRelationNodeFunds(deletionPlan.Heads);
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
											Topups: {
												where: unrecoveredHydraTopupWhere,
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
					// Said separately, because the answer is different. Reconciliation
					// finishes on its own; a deposit the head never took has to be
					// recovered by hand, and the row about to be deleted holds the only
					// transaction hash that names it.
					const unrecoveredDepositCount = relation.Heads.reduce((total, head) => total + head._count.Topups, 0);
					if (unrecoveredDepositCount > 0) {
						throw createHttpError(
							409,
							`Cannot delete relation: ${unrecoveredDepositCount} deposit(s) were never absorbed or recovered. ` +
								'Recover them first — deleting this takes the transaction hashes that name them.',
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
