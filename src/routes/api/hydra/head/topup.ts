import createHttpError from 'http-errors';
import { SLOT_CONFIG_NETWORK } from '@meshsdk/core';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { convertNetwork } from '@/utils/converter/network-convert';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraTopupStatus } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';
import type { CommitUtxoFilter } from '@/lib/hydra';
import { executeHydraTopup } from '@/services/hydra-topup/execute';
import { recoverHydraDeposit } from '@/services/hydra-topup/recover';

export const topupInput = z.object({
	headId: z.string().describe('The Hydra head to top up'),
	assetFilter: z
		.enum(['all', 'ada-only'])
		.optional()
		.default('all')
		.describe('Which plain wallet UTxOs to commit: all, or ADA-only (ignored when assetUnit is set)'),
	assetUnit: z
		.string()
		.regex(/^[0-9a-fA-F]{56,120}$/)
		.optional()
		.describe('Commit only UTxOs containing this native-asset unit (policyId + assetName hex)'),
	exactAmount: z
		.string()
		.regex(/^\d+$/)
		.optional()
		.describe(
			'Exact top-up amount (base unit) of assetUnit (or lovelace). Pre-splits a dedicated L1 UTxO first, then commits it — adds an L1 confirmation wait.',
		),
});

export const topupOutput = z.object({
	headId: z.string(),
	accepted: z.literal(true),
});

export const listTopupsInput = z.object({
	headId: z.string().describe('The Hydra head whose top-ups to list'),
	limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const listTopupsOutput = z.object({
	topups: z.array(
		z.object({
			id: z.string(),
			createdAt: z.string(),
			updatedAt: z.string(),
			status: z.nativeEnum(HydraTopupStatus),
			depositTxHash: z.string(),
			committedLovelace: z.string(),
			committedAssets: z.record(z.string(), z.string()),
			/**
			 * When the head stops being able to absorb this deposit.
			 *
			 * A deposit confirming on L1 is only half the story: the head folds it
			 * in with a snapshot both parties sign, and if that has not happened by
			 * this moment it never will. Without the deadline the UI could only say
			 * "being folded in", which stays true-looking forever.
			 */
			deadline: z.string(),
			/**
			 * When the head can first take this deposit.
			 *
			 * A deposit confirming on chain is not the same as the head holding it:
			 * a node ignores a deposit until it is older than the deposit period,
			 * so between those two moments the money is on chain, spoken for, and
			 * unusable. Reporting only "Confirmed" made that gap look like success.
			 */
			usableFrom: z.string(),
		}),
	),
});

export const recoverTopupInput = z.object({
	topupId: z.string().min(1).describe('The deposit to recover'),
});

export const recoverTopupOutput = z.object({
	depositTxHash: z.string(),
	requested: z.boolean(),
	reason: z.string().nullable(),
});

/**
 * Return a deposit the head never absorbed.
 *
 * The funds sit at a deposit script rather than in the wallet, and only the node
 * can spend them back, and only once the deadline in the deposit's datum has
 * passed.
 */
export const recoverTopupPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: recoverTopupInput,
	output: recoverTopupOutput,
	handler: async ({ input }) => await recoverHydraDeposit(input.topupId),
});

/**
 * Deposits into this head, newest first.
 *
 * A top-up is not one transaction and not quick: an exact amount is split off
 * into its own L1 UTxO and that split has to confirm before the deposit can
 * even be built, which is minutes. Without somewhere to see them, the only
 * feedback was a request that appeared to hang.
 */
export const listTopupsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listTopupsInput,
	output: listTopupsOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			select: { HydraRelation: { select: { network: true } } },
		});
		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}
		const slotConfig = SLOT_CONFIG_NETWORK[convertNetwork(head.HydraRelation.network)];
		const deadlineMsOf = (slot: bigint) =>
			slotConfig.zeroTime + (Number(slot) - slotConfig.zeroSlot) * slotConfig.slotLength;

		const rows = await prisma.hydraTopup.findMany({
			where: { hydraHeadId: input.headId },
			orderBy: { createdAt: 'desc' },
			take: input.limit,
		});
		return {
			topups: rows.map((row) => ({
				id: row.id,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
				status: row.status,
				depositTxHash: row.depositTxHash,
				committedLovelace: row.committedLovelace.toString(),
				deadline: new Date(deadlineMsOf(row.invalidHereafterSlot)).toISOString(),
				// The node writes the deadline as `deposit + 3·DP` and will not touch
				// the deposit before `deposit + DP`, so a third of the way there is
				// exactly when it becomes eligible.
				usableFrom: new Date(
					row.createdAt.getTime() + (deadlineMsOf(row.invalidHereafterSlot) - row.createdAt.getTime()) / 3,
				).toISOString(),
				committedAssets: (row.committedAssets ?? {}) as Record<string, string>,
			})),
		};
	},
});

/**
 * Start a top-up. Does not wait for it.
 *
 * The work is minutes long — an exact amount is split into its own L1 UTxO,
 * that split must confirm, then the deposit is built, submitted and confirmed —
 * and holding an HTTP request open across all of it gave an operator a spinner
 * with no way to tell progress from failure. Nothing is lost by returning
 * early: every state transition after submission is owned by reconciliation
 * anyway, which is what makes the deposit recoverable if this process dies.
 *
 * The resulting HydraTopup rows are readable through listTopupsGet.
 */
export const topupHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: topupInput,
	output: topupOutput,
	handler: async ({ input }) => {
		const filter: CommitUtxoFilter = input.assetUnit ? { unit: input.assetUnit } : input.assetFilter;
		const exact = input.exactAmount ? { unit: input.assetUnit ?? 'lovelace', amount: BigInt(input.exactAmount) } : null;

		// Detached deliberately. A rejection here is logged rather than returned
		// because the caller has already been answered, and reconciliation — not
		// this promise — decides what a submitted deposit finally becomes.
		void executeHydraTopup({ headId: input.headId, filter, exact }).catch((error: unknown) => {
			logger.error(`hydra: top-up of head ${input.headId} failed: ${(error as Error).message}`);
		});

		return { headId: input.headId, accepted: true as const };
	},
});
