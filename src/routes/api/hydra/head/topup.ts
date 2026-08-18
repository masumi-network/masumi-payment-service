import createHttpError from 'http-errors';
import { MIN_CARVE_LOVELACE } from '@/services/hydra-topup/pre-split';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus, HydraTopupStatus } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';
import type { CommitUtxoFilter } from '@/lib/hydra';
import { executeHydraTopup } from '@/services/hydra-topup/execute';
import { recoverHydraDeposit } from '@/services/hydra-topup/recover';
import { DEFAULT_PERIODS } from '@/services/hydra-invite/provisioning';
import { POSITIVE_BASE_UNIT_AMOUNT, POSITIVE_BASE_UNIT_AMOUNT_MESSAGE } from '@/routes/api/hydra/head/amounts';
import { assertNodeReadyForDeposit } from '@/routes/api/hydra/head';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';

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
		.regex(POSITIVE_BASE_UNIT_AMOUNT, POSITIVE_BASE_UNIT_AMOUNT_MESSAGE)
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
			depositTxHash: z.string().nullable(),
			splitTxHash: z
				.string()
				.nullable()
				.describe('The L1 transaction that carved the exact amount, while a top-up is still preparing'),
			committedLovelace: z.string(),
			committedAssets: z.record(z.string(), z.string()),
			/**
			 * When the deposit may be sent back, from the deposit's own datum.
			 *
			 * The head writes this as `deposit + 3·depositPeriod` and will not
			 * release the funds before it, so it is the moment recovery becomes
			 * possible — NOT the last moment the head might still take the deposit,
			 * which is `absorbBy` below and a whole period earlier.
			 *
			 * Null until the node has observed the deposit and said so. It is set
			 * from the drafting node's chain time, so there is nothing to derive it
			 * from in the meantime. It was previously derived from the deposit
			 * transaction's own validity TTL, which is a different quantity
			 * entirely and read roughly half an hour early — making healthy
			 * deposits look expired while they were still perfectly on track.
			 */
			deadline: z.string().nullable(),
			/**
			 * When the head can first take this deposit.
			 *
			 * A deposit confirming on chain is not the same as the head holding it:
			 * a node ignores a deposit until it is older than the deposit period,
			 * so between those two moments the money is on chain, spoken for, and
			 * unusable. Reporting only "Confirmed" made that gap look like success.
			 */
			usableFrom: z.string().nullable(),
			/**
			 * The last moment the head will still absorb this deposit.
			 *
			 * A node refuses a deposit that has less than one deposit period left
			 * before its deadline, so the window to be folded in closes a period
			 * before the deadline does — and the gap between the two is dead time
			 * in which the deposit can neither be taken nor recovered.
			 */
			absorbBy: z.string().nullable(),
			/**
			 * When the node was asked to send this deposit back.
			 *
			 * Set, the deposit is on its way to the wallet and there is nothing left
			 * to press. Read from the record rather than remembered by the page, so
			 * a reload does not offer the button again.
			 */
			recoveryRequestedAt: z.string().nullable(),
		}),
	),
});

export const recoverTopupInput = z.object({
	topupId: z.string().min(1).describe('The deposit to recover'),
});

export const recoverTopupOutput = z.object({
	depositTxHash: z.string().nullable(),
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
 * A deposit milestone, expressed as whole deposit periods from the deadline.
 *
 * The head states one time — the deadline in the deposit's datum — and the two
 * that matter operationally sit a fixed number of periods before it. Anchored
 * on the deadline rather than on the deposit time because the deadline is the
 * only one of the three the head ever tells anyone.
 */
export function shiftPeriods(deadline: Date | null, periods: number, depositPeriodSeconds: number): string | null {
	if (deadline === null) return null;
	return new Date(deadline.getTime() + periods * depositPeriodSeconds * 1000).toISOString();
}

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
			select: {
				HydraRelation: { select: { network: true } },
				Invite: { select: { depositPeriodSeconds: true } },
			},
		});
		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}
		// The period this head runs on, as signed into the invite that opened it.
		const depositPeriodSeconds = head.Invite?.depositPeriodSeconds ?? DEFAULT_PERIODS.depositPeriodSeconds;

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
				splitTxHash: row.splitTxHash,
				committedLovelace: row.committedLovelace.toString(),
				// All three come from the one deadline the head itself stated, and are
				// null together until it has: the deadline is set from the drafting
				// node's chain time, and neither the deposit transaction nor the time
				// the operator asked can stand in for it. Deriving them from the
				// transaction's validity TTL, as this once did, read about half an
				// hour early and made healthy deposits look expired.
				deadline: row.nodeDeadline?.toISOString() ?? null,
				// The node writes the deadline as `deposit + 3·DP` and will not take
				// the deposit before `deposit + DP`, which is two periods before it.
				usableFrom: shiftPeriods(row.nodeDeadline, -2, depositPeriodSeconds),
				// And refuses one with less than a period left, which closes the
				// window a period before the deadline rather than at it.
				absorbBy: shiftPeriods(row.nodeDeadline, -1, depositPeriodSeconds),
				committedAssets: (row.committedAssets ?? {}) as Record<string, string>,
				recoveryRequestedAt: row.recoveryRequestedAt?.toISOString() ?? null,
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
		// Answered before the work is detached, the same as the withdraw endpoint.
		// The refusals below are decided in milliseconds and are the operator's to
		// see: without them a top-up of a head that does not exist, is disabled, or
		// is not Open returned "Top-up started" and put the reason in a log the
		// operator was never going to read. The executor re-checks all three —
		// minutes pass before it acts, and the head can change in between.
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			select: { isEnabled: true, status: true, headIdentifier: true, LocalParticipant: { select: { id: true } } },
		});
		if (!head) throw createHttpError(404, 'Hydra head not found');
		if (!head.isEnabled) throw createHttpError(409, 'Cannot top up a disabled Hydra head');
		if (head.status !== HydraHeadStatus.Open) {
			throw createHttpError(409, `Cannot top up: head status is ${head.status}, expected Open`);
		}
		if (!head.LocalParticipant) throw createHttpError(400, 'Head has no local participant');
		if (!head.headIdentifier) {
			throw createHttpError(409, 'Cannot top up before the Hydra head identifier has been observed');
		}
		if (getHydraConnectionManager().getHead(input.headId) === null) {
			throw createHttpError(502, 'No active connection to Hydra head');
		}
		// The same check the initial commit makes inline, and for the same reason: a
		// deposit made while the node is still catching up lands on L1 immediately
		// and is unabsorbable until it is not, so its deadline can pass while it
		// waits. Decided in milliseconds, and the operator is the one who can act on
		// it — answering "Deposit started" and putting "still catching up" in a log
		// is how the admin UI came to say one thing while the API did another.
		await assertNodeReadyForDeposit(head.LocalParticipant.id);

		// `exclusive` for a token top-up. Hydra commits WHOLE UTxOs and a wallet's
		// change consolidates, so a UTxO holding the requested token alongside an
		// agent's registry NFT is routinely the one this would pick — and the NFT
		// goes into the head with it, off L1 and out of reach of any registry
		// update until someone decommits or closes the head. Nobody asked for that
		// by naming an asset unit, and `exactAmount` is the way to top up from a
		// mixed wallet: it carves the amount into its own UTxO and leaves every
		// other asset behind in the change.
		const filter: CommitUtxoFilter = input.assetUnit ? { unit: input.assetUnit, exclusive: true } : input.assetFilter;
		const exact = input.exactAmount ? { unit: input.assetUnit ?? 'lovelace', amount: BigInt(input.exactAmount) } : null;
		// The ledger refuses an output below the minimum its size costs, so a carve
		// under the floor cannot be built. Refused here rather than after the wallet
		// has been claimed and the caller has already been told the top-up started.
		if (exact && exact.unit === 'lovelace' && exact.amount < MIN_CARVE_LOVELACE) {
			throw createHttpError(
				400,
				`exactAmount must be at least ${MIN_CARVE_LOVELACE} lovelace: a smaller top-up cannot be carved into its own UTxO`,
			);
		}

		// Detached deliberately. A rejection here is logged rather than returned
		// because the caller has already been answered, and reconciliation — not
		// this promise — decides what a submitted deposit finally becomes.
		void executeHydraTopup({ headId: input.headId, filter, exact }).catch((error: unknown) => {
			logger.error(`hydra: top-up of head ${input.headId} failed: ${(error as Error).message}`);
		});

		return { headId: input.headId, accepted: true as const };
	},
});
