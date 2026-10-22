/**
 * Finishing redemptions that a crash or a Host outage interrupted.
 *
 * A redemption the issuer acknowledged is owed: the nonce is spent, the issuer
 * is waiting for our node, and nothing about it can be undone. The request that
 * started it may be long gone, so this job carries it the rest of the way:
 * configure and start the node, then create the head.
 *
 * It never posts. The operator's HTTP and private-network opt-ins are not stored,
 * so only a request can reach the issuer, and a redemption the issuer has not
 * acknowledged waits for its operator to retry the same code. The only thing
 * done for those is the bounded cleanup below.
 */
import { HydraHeadStatus, HydraInviteRole, HydraInviteStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { nonceLogRef } from './nonce-log-ref';
import { createHeadFromExchange } from './orchestrator';
import { advanceRedemption } from './redemption';
import { buildRedemptionPorts, toRedemptionState, type RedeemerRecord } from './redemption-ports';

/**
 * How long a record must sit untouched before the job takes it over. Long enough
 * that the request that is still working on it finishes first; short enough that
 * a crash is healed within a minute. A record waiting only for a head to be
 * allowed waits longer, because retrying it is a handful of queries each time.
 */
const NODE_SETUP_IDLE_MS = 60_000;
const HEAD_CREATION_IDLE_MS = 5 * 60_000;

/** Bounds one pass so a Host that is down cannot hold the scheduler tick. */
const MAX_RECORDS_PER_PASS = 10;
const PASS_BUDGET_MS = 45_000;

/**
 * How long past its expiry an unacknowledged redemption is kept. The issuer's
 * Host answers a repeat of a redemption for seven days after the service forgets
 * it, and an invite can be redeemed right up to its expiry, so a retry can still
 * succeed for about that long afterwards. A day on top is the margin. Past it
 * nothing can confirm the redemption, so it is failed and its reservation
 * released rather than held for as long as the invite's own lifetime allowed.
 */
const UNCONFIRMED_GIVE_UP_MS = 8 * 24 * 60 * 60 * 1000;

export type ResumeOutcome = {
	resumed: number;
	failed: number;
	skipped: number;
	blocked: number;
	expired: number;
};

const include = { LocalHotWallet: true, HydraHost: true } as const;

async function failStaleUnconfirmed(now: number, outcome: ResumeOutcome): Promise<void> {
	const stale = await prisma.hydraHeadInvite.findMany({
		where: {
			role: HydraInviteRole.Redeemer,
			status: HydraInviteStatus.Redeemed,
			redeemedAt: null,
			expiresAt: { lt: new Date(now - UNCONFIRMED_GIVE_UP_MS) },
		},
		include,
	});
	for (const record of stale) {
		try {
			const ports = buildRedemptionPorts({ record, transport: undefined, createHead: createHeadFromExchange });
			// A claim first: a retry the issuer acknowledges a moment from now claims
			// the record before it posts, and must not find it already failed.
			if (!(await ports.claim()) || !(await ports.fail())) continue;
			outcome.expired += 1;
			logger.warn(
				`hydra: redemption ${nonceLogRef(record.nonce)} was never acknowledged and its invite expired more than eight days ago; ` +
					'it is failed and its node released. Ask the issuer for a new invite',
			);
		} catch (error) {
			logger.warn(
				`hydra: could not fail the stale redemption ${nonceLogRef(record.nonce)}: ${(error as Error).message}`,
			);
		}
	}
}

/** True while the pair still has a head that must finish before another can be created. */
async function hasBlockingHead(record: RedeemerRecord): Promise<boolean> {
	const head = await prisma.hydraHead.findFirst({
		where: {
			status: { not: HydraHeadStatus.Final },
			retiredAt: null,
			HydraRelation: {
				network: record.network,
				localHotWalletId: record.localHotWalletId,
				RemoteWallet: { walletAddress: record.issuerWalletAddress },
			},
		},
		select: { status: true },
	});
	return head !== null;
}

export async function resumeHydraRedemptions(
	options: { now?: () => number; passBudgetMs?: number } = {},
): Promise<ResumeOutcome> {
	const now = options.now ?? Date.now;
	const budgetMs = options.passBudgetMs ?? PASS_BUDGET_MS;
	const startedAt = now();
	const outcome: ResumeOutcome = { resumed: 0, failed: 0, skipped: 0, blocked: 0, expired: 0 };

	await failStaleUnconfirmed(startedAt, outcome);

	const candidates = await prisma.hydraHeadInvite.findMany({
		where: {
			role: HydraInviteRole.Redeemer,
			// Only what the issuer acknowledged. The job cannot post, so an
			// unacknowledged record is none of its business.
			redeemedAt: { not: null },
			// A paused Host takes no work; the record resumes after Resume.
			HydraHost: { pausedAt: null },
			OR: [
				{ status: HydraInviteStatus.Redeemed, updatedAt: { lt: new Date(startedAt - NODE_SETUP_IDLE_MS) } },
				{ status: HydraInviteStatus.Started, updatedAt: { lt: new Date(startedAt - HEAD_CREATION_IDLE_MS) } },
			],
		},
		include,
		orderBy: { updatedAt: 'asc' },
		take: MAX_RECORDS_PER_PASS,
	});

	for (const record of candidates) {
		if (now() - startedAt >= budgetMs) break;

		// A claim, not a lock: it stops two instances from doing the same work in
		// the same minute. A holder that outlives the idle window is harmless,
		// because everything advanceRedemption does is safe to repeat.
		const claimed = await prisma.hydraHeadInvite.updateMany({
			where: { id: record.id, role: HydraInviteRole.Redeemer, status: record.status, updatedAt: record.updatedAt },
			data: { updatedAt: new Date(now()) },
		});
		if (claimed.count !== 1) {
			outcome.skipped += 1;
			continue;
		}

		try {
			if (record.status === HydraInviteStatus.Started && (await hasBlockingHead(record))) {
				outcome.blocked += 1;
				continue;
			}
			const ports = buildRedemptionPorts({ record, transport: undefined, createHead: createHeadFromExchange });
			const result = await advanceRedemption(toRedemptionState(record), ports, { rowIsNew: false, mayPost: false });
			if (result.done) {
				outcome.resumed += 1;
				logger.info(`hydra: finished redemption ${nonceLogRef(record.nonce)}; head ${result.hydraHeadId} recorded`);
			}
		} catch (error) {
			outcome.failed += 1;
			// Kept and retried: the nonce is spent, so the redemption is owed.
			logger.warn(`hydra: could not yet finish redemption ${nonceLogRef(record.nonce)}: ${(error as Error).message}`);
		}
	}
	return outcome;
}
