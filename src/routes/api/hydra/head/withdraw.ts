import createHttpError from 'http-errors';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraDecommitStatus, HydraHeadStatus } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';
import { executeHydraDecommit } from '@/services/hydra-decommit/execute';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { POSITIVE_BASE_UNIT_AMOUNT, POSITIVE_BASE_UNIT_AMOUNT_MESSAGE } from '@/routes/api/hydra/head/amounts';
import { assertNodeReadyForDeposit } from '@/routes/api/hydra/head';

export const withdrawInput = z.object({
	headId: z.string().describe('The Hydra head to withdraw from'),
	lovelace: z
		.string()
		.regex(POSITIVE_BASE_UNIT_AMOUNT, POSITIVE_BASE_UNIT_AMOUNT_MESSAGE)
		.optional()
		.describe(
			'Exact lovelace to withdraw. Omit to withdraw every eligible in-head UTxO whole. An exact amount is split off inside the head first, which costs nothing and takes about a second.',
		),
	assetUnit: z
		.string()
		.regex(/^[0-9a-fA-F]{56,120}$/)
		.optional()
		.describe(
			'Withdraw a native asset instead of ADA: policy id and asset name concatenated. Exactly the amount asked for is split off inside the head first, the same as an ADA withdrawal, so the rest stays where it is.',
		),
	assetAmount: z
		.string()
		.regex(POSITIVE_BASE_UNIT_AMOUNT, POSITIVE_BASE_UNIT_AMOUNT_MESSAGE)
		.optional()
		.describe("How much of assetUnit to withdraw, in that asset's own smallest unit."),
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
			/**
			 * The in-head decommit transaction. Not on L1 and not linkable: it
			 * only ever existed inside the head.
			 */
			decommitTxId: z.string().nullable(),
			/**
			 * The L1 transaction that paid it out, once identified. Null while it
			 * is still in the head, and also when the search did not find it.
			 */
			l1TxId: z.string().nullable(),
			requestedLovelace: z.string(),
			requestedAssets: z
				.record(z.string(), z.string())
				.describe('Native assets this withdrawal set out to remove, as { unit: quantity }.'),
			/**
			 * What actually reached L1. Null until the withdrawal finalizes, and
			 * routinely different from what was requested: a decommit takes whole
			 * outputs, so a token withdrawal also moves whatever ADA that output
			 * held, and the decrement's fee comes out of the value that travels.
			 */
			settledLovelace: z.string().nullable(),
			settledAssets: z.record(z.string(), z.string()).nullable(),
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
				l1TxId: row.l1TxId,
				requestedLovelace: row.requestedLovelace.toString(),
				requestedAssets: (row.requestedAssets ?? {}) as Record<string, string>,
				settledLovelace: row.settledLovelace?.toString() ?? null,
				settledAssets: (row.settledAssets as Record<string, string> | null) ?? null,
				destinationAddress: row.destinationAddress,
				failureReason: row.failureReason,
				approvedAt: row.approvedAt?.toISOString() ?? null,
				finalizedAt: row.finalizedAt?.toISOString() ?? null,
			})),
		};
	},
});

/**
 * Refuse an amount that does not describe one withdrawal.
 *
 * Half an asset withdrawal is not a smaller withdrawal, it is a different one:
 * with only one of the two fields set the asset is dropped, and a request with
 * no amount at all means "take every eligible UTxO whole". An operator who
 * asked for 5 of a token and left the amount out of the body would have emptied
 * their side of the head instead.
 *
 * Exported so the shape can be asserted directly; the handler is the only
 * caller.
 */
export function assertWithdrawAmountShape(input: {
	lovelace?: string | undefined;
	assetUnit?: string | undefined;
	assetAmount?: string | undefined;
}): void {
	if ((input.assetUnit === undefined) !== (input.assetAmount === undefined)) {
		throw createHttpError(400, 'assetUnit and assetAmount go together; supply both or neither');
	}
	if (input.assetUnit !== undefined && input.lovelace !== undefined) {
		throw createHttpError(400, 'withdraw either lovelace or one native asset per request, not both');
	}
}

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
		assertWithdrawAmountShape(input);

		// Every refusal the executor decides before its `try` block, mirrored here.
		// The work itself outlives the request, but none of these is recorded: no
		// `HydraDecommit` row, no head error, nothing in the withdrawal list. The
		// operator was shown "Withdrawal started" for a withdrawal that had already
		// been refused, and the reason went to a log they were never going to read.
		// The executor re-checks all of it, because minutes pass before it acts.
		//
		// Kept in step with `executeHydraDecommit` deliberately: this list used to
		// stop at the connection check while the executor went on to refuse a
		// participant-less head and a node still catching up, which are exactly the
		// two an operator hits on a head that is otherwise healthy.
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			select: { isEnabled: true, status: true, headIdentifier: true, LocalParticipant: { select: { id: true } } },
		});
		if (!head) throw createHttpError(404, 'Hydra head not found');
		if (!head.isEnabled) throw createHttpError(409, 'Cannot withdraw from a disabled Hydra head');
		if (head.status !== HydraHeadStatus.Open) {
			throw createHttpError(409, `Cannot withdraw: head status is ${head.status}, expected Open`);
		}
		if (!head.LocalParticipant) throw createHttpError(400, 'Head has no local participant');
		if (!head.headIdentifier) {
			throw createHttpError(409, 'Cannot withdraw before the Hydra head identifier has been observed');
		}
		if (getHydraConnectionManager().getHead(input.headId) === null) {
			throw createHttpError(502, 'No active connection to Hydra head');
		}
		// A withdrawal makes no L1 deposit, so it has no deadline to miss, but it
		// still needs the head to sign and a node that is catching up will not.
		// Decided in milliseconds, and the operator is the one who can act on it.
		await assertNodeReadyForDeposit(head.LocalParticipant.id);

		void executeHydraDecommit({
			headId: input.headId,
			lovelace: input.lovelace ? BigInt(input.lovelace) : null,
			asset: input.assetUnit && input.assetAmount ? { unit: input.assetUnit, amount: BigInt(input.assetAmount) } : null,
			drain: input.drain,
		}).catch((error: unknown) => {
			logger.error(`hydra: withdrawal from head ${input.headId} failed: ${(error as Error).message}`);
		});

		return { headId: input.headId, accepted: true as const };
	},
});
