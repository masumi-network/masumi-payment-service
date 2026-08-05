import createHttpError from 'http-errors';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraDecommitStatus } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';
import { executeHydraDecommit } from '@/services/hydra-decommit/execute';

export const withdrawInput = z.object({
	headId: z.string().describe('The Hydra head to withdraw from'),
	lovelace: z
		.string()
		.regex(/^\d+$/)
		.optional()
		.describe(
			'Exact lovelace to withdraw. Omit to withdraw every eligible in-head UTxO whole. An exact amount is split off inside the head first, which costs nothing and takes about a second.',
		),
	drain: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'Also withdraw the UTxO held back as collateral. Without collateral this wallet can no longer spend escrows inside the head, so this is for winding a head down.',
		),
});

export const withdrawOutput = z.object({
	headId: z.string(),
	accepted: z.literal(true),
});

export const listWithdrawalsInput = z.object({
	headId: z.string().describe('The Hydra head whose withdrawals to list'),
	limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const listWithdrawalsOutput = z.object({
	withdrawals: z.array(
		z.object({
			id: z.string(),
			createdAt: z.string(),
			updatedAt: z.string(),
			status: z.nativeEnum(HydraDecommitStatus),
			/**
			 * The in-head transaction that split the exact amount off, when one was
			 * needed. Null for a whole-UTxO withdrawal, which needs no split.
			 */
			splitTxId: z.string().nullable(),
			decommitTxId: z.string().nullable(),
			requestedLovelace: z.string(),
			destinationAddress: z.string(),
			failureReason: z.string().nullable(),
			/**
			 * When the head signed the removal.
			 *
			 * Reported separately from finalization because it is the point of no
			 * return: from here the value is out of the head whatever happens on L1,
			 * and an operator watching a withdrawal needs to know it has passed.
			 */
			approvedAt: z.string().nullable(),
			/** When the funds became spendable on L1. */
			finalizedAt: z.string().nullable(),
		}),
	),
});

/**
 * Withdrawals from this head, newest first.
 *
 * A withdrawal passes through the head before it reaches L1 and each leg can
 * fail differently, so the list reports where one got to rather than whether it
 * is done.
 */
export const listWithdrawalsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listWithdrawalsInput,
	output: listWithdrawalsOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({ where: { id: input.headId }, select: { id: true } });
		if (!head) throw createHttpError(404, 'Hydra head not found');

		const rows = await prisma.hydraDecommit.findMany({
			where: { hydraHeadId: input.headId },
			orderBy: { createdAt: 'desc' },
			take: input.limit,
		});
		return {
			withdrawals: rows.map((row) => ({
				id: row.id,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
				status: row.status,
				splitTxId: row.splitTxId,
				decommitTxId: row.decommitTxId,
				requestedLovelace: row.requestedLovelace.toString(),
				destinationAddress: row.destinationAddress,
				failureReason: row.failureReason,
				approvedAt: row.approvedAt?.toISOString() ?? null,
				finalizedAt: row.finalizedAt?.toISOString() ?? null,
			})),
		};
	},
});

/**
 * Start a withdrawal. Does not wait for it.
 *
 * Same reasoning as the top-up endpoint: the work outlives the request. An
 * exact amount is split inside the head, the decommit is proposed, and the head
 * then has to sign a snapshot removing it before its node posts the L1
 * transaction — none of which this request can usefully hold open. The resulting
 * rows are readable through listWithdrawalsGet.
 */
export const withdrawHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: withdrawInput,
	output: withdrawOutput,
	handler: async ({ input }) => {
		void executeHydraDecommit({
			headId: input.headId,
			lovelace: input.lovelace ? BigInt(input.lovelace) : null,
			drain: input.drain,
		}).catch((error: unknown) => {
			logger.error(`hydra: withdrawal from head ${input.headId} failed: ${(error as Error).message}`);
		});

		return { headId: input.headId, accepted: true as const };
	},
});
