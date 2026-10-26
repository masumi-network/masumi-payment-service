/**
 * Finishing redemptions that a crash or a Host outage interrupted.
 *
 * A redemption the issuer acknowledged is owed: the nonce is spent, the issuer
 * is waiting for our node, and nothing about it can be undone. The request that
 * started it may be long gone, so this job carries it the rest of the way:
 * configure and start the node, then create the head.
 *
 * A redemption the issuer has not acknowledged is sent again, which is how one
 * whose answer was lost learns it landed: the issuer's Host answers an identical
 * repeat with the same acknowledgement. The operator's HTTP and private-network
 * opt-ins are not stored, so the job sends with neither; a redemption that needs
 * them waits for its operator to retry the same code, or for the bounded cleanup
 * below.
 */
import { HydraHeadStatus, HydraInviteRole, HydraInviteStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { nonceLogRef } from './nonce-log-ref';
import { revealInviteNonce } from './invite-secrets';
import { createHeadFromExchange } from './orchestrator';
import { advanceRedemption } from './redemption';
import { buildRedemptionPorts, toRedemptionState, type RedeemerRecord } from './redemption-ports';

/**
 * How long a record must sit untouched before the job takes it over. Long enough
 * that the request that is still working on it finishes first; short enough that
 * a crash is healed within a minute. A record waiting only for a head to be
 * allowed waits longer, because retrying it is a handful of queries each time,
 * and so does one still waiting for the issuer, because each retry is a request
 * to someone else's Host.
 */
const NODE_SETUP_IDLE_MS = 60_000;
const HEAD_CREATION_IDLE_MS = 5 * 60_000;
const UNCONFIRMED_RETRY_IDLE_MS = 5 * 60_000;

/** The strictest transport: no plain HTTP and no private address, whatever the operator once allowed. */
const RESUME_TRANSPORT = { allowInsecureHttp: false, allowPrivateNetwork: false } as const;

/** Bounds one pass so a Host that is down cannot hold the scheduler tick. */
const MAX_RECORDS_PER_PASS = 10;
const PASS_BUDGET_MS = 45_000;

/**
 * How long past its expiry an unacknowledged redemption is kept. The pass below
 * sends it again every few minutes, and the issuer's Host answers a repeat of a
 * redemption that landed for as long as it holds it, so a record still here this
 * long after expiry has had eight days of retries go unconfirmed: the Host was
 * unreachable throughout, needs an opt-in the job does not have, or no longer
 * knows the redemption. It is failed, and its node left to the
 * abandoned-reservation sweep, rather than held indefinitely.
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
	const giveUpBefore = new Date(now - UNCONFIRMED_GIVE_UP_MS);
	const stale = await prisma.hydraHeadInvite.findMany({
		where: {
			role: HydraInviteRole.Redeemer,
			status: HydraInviteStatus.Redeemed,
			redeemedAt: null,
			expiresAt: { lt: giveUpBefore },
			// Idle, like every record the pass below takes: a retry that claimed the
			// record a moment ago may be posting it now, and its claim predates the
			// one below, so only the idle window keeps this from failing it mid-post.
			updatedAt: { lt: new Date(now - UNCONFIRMED_RETRY_IDLE_MS) },
			// The pass below sends nothing for a paused Host, so its days paused are
			// not days of retries, and they must not count toward giving up: the
			// eight days restart when the Host resumes.
			HydraHost: { pausedAt: null, OR: [{ resumedAt: null }, { resumedAt: { lt: giveUpBefore } }] },
		},
		include,
		orderBy: { expiresAt: 'asc' },
		take: MAX_RECORDS_PER_PASS,
	});
	for (const record of stale) {
		try {
			const ports = buildRedemptionPorts({ record, transport: RESUME_TRANSPORT, createHead: createHeadFromExchange });
			// A claim first: a retry the issuer acknowledges a moment from now claims
			// the record before it posts, and must not find it already failed.
			if (!(await ports.claim()) || !(await ports.fail())) continue;
			outcome.expired += 1;
			logger.warn(
				`hydra: redemption ${nonceLogRef(revealInviteNonce(record))} was never acknowledged and its invite expired more than eight days ago; ` +
					'it is failed and its node will be released. Ask the issuer for a new invite',
			);
		} catch (error) {
			logger.warn(`hydra: could not fail the stale redemption ${record.id}: ${(error as Error).message}`);
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
			// A paused Host takes no work; the record resumes after Resume.
			HydraHost: { pausedAt: null },
			OR: [
				{
					status: HydraInviteStatus.Redeemed,
					redeemedAt: { not: null },
					updatedAt: { lt: new Date(startedAt - NODE_SETUP_IDLE_MS) },
				},
				{
					status: HydraInviteStatus.Redeemed,
					redeemedAt: null,
					updatedAt: { lt: new Date(startedAt - UNCONFIRMED_RETRY_IDLE_MS) },
				},
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
		const claimedAt = new Date(now());
		const claimed = await prisma.hydraHeadInvite.updateMany({
			where: { id: record.id, role: HydraInviteRole.Redeemer, status: record.status, updatedAt: record.updatedAt },
			data: { updatedAt: claimedAt },
		});
		if (claimed.count !== 1) {
			outcome.skipped += 1;
			continue;
		}
		// The version the ports guard their writes with is the one this claim wrote,
		// or the claim an unacknowledged record needs before it is sent would fail.
		const current = { ...record, updatedAt: claimedAt };

		try {
			// Whatever the step: a node started, or a redemption sent, for a head that
			// cannot be created yet would only wait beside the live one.
			if (await hasBlockingHead(current)) {
				outcome.blocked += 1;
				continue;
			}
			const ports = buildRedemptionPorts({
				record: current,
				transport: RESUME_TRANSPORT,
				createHead: createHeadFromExchange,
			});
			const result = await advanceRedemption(toRedemptionState(current), ports, { rowIsNew: false });
			outcome.resumed += 1;
			logger.info(
				`hydra: finished redemption ${nonceLogRef(revealInviteNonce(record))}; head ${result.hydraHeadId} recorded`,
			);
		} catch (error) {
			outcome.failed += 1;
			// Kept and retried on a later pass, unless the attempt proved the nonce
			// is someone else's, in which case advanceRedemption already failed it.
			logger.warn(`hydra: could not yet finish redemption ${record.id}: ${(error as Error).message}`);
		}
	}
	return outcome;
}
