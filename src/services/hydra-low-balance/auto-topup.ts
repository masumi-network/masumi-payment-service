import { HydraHeadStatus, HydraTopupStatus, LowBalanceStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { CommitUtxoFilter } from '@/lib/hydra';
import { executeHydraTopup } from '@/services/hydra-topup/execute';

/**
 * Automatic low-balance top-up. For every rule that is currently Low with
 * `topupEnabled`, commit more funds into the participant's Open head from its OWN
 * assigned funding wallet (never a third-party wallet — a top-up from another
 * wallet could not be credited to this participant in the head), bounded to the
 * rule's `topupAmount`.
 *
 * De-duplication: skipped when a Pending top-up already exists for the
 * participant (the deposit could still land) — executeHydraTopup also enforces
 * this atomically, so a race merely surfaces a benign 409. Because the scan only
 * acts while the rule stays Low and the monitor flips it back to Healthy once the
 * in-head balance recovers, top-ups stop on their own; they also stop when the
 * wallet has no more matching UTxOs (nothing left to commit).
 */
/**
 * When an in-flight deposit stops being an explanation and becomes a problem.
 *
 * Comfortably past the longest deposit period a node will hold one for —
 * twenty minutes on mainnet — plus the reconciler's own polling, so an ordinary
 * absorption never trips it.
 */
const STALLED_TOPUP_AFTER_MS = 60 * 60 * 1000;

export async function runHydraAutoTopupCycle(): Promise<void> {
	const rules = await prisma.hydraLowBalanceRule.findMany({
		where: { enabled: true, topupEnabled: true, status: LowBalanceStatus.Low },
		include: {
			LocalParticipant: { select: { id: true, HydraHead: { select: { id: true, status: true } } } },
		},
	});

	for (const rule of rules) {
		try {
			const head = rule.LocalParticipant.HydraHead;
			if (!head || head.status !== HydraHeadStatus.Open) continue;
			if (rule.topupAmount == null || rule.topupAmount <= 0n) continue;

			// Counted up to and including `Confirmed`, not just `Pending`. A deposit
			// reaching the chain is not the head holding it: the node ignores a
			// deposit until it is older than the deposit period — ten minutes on
			// preprod, twenty on mainnet — so between confirmation and absorption
			// the in-head balance is unchanged and the rule is still Low. With only
			// `Pending` counted, that whole window looked like "no top-up in
			// flight", and this cycle, which runs every thirty seconds, sent
			// another deposit, and another, until the wallet ran out of matching
			// UTxOs: the rule's `topupAmount` moved into the head ten or twenty
			// times over.
			const inFlight = await prisma.hydraTopup.findMany({
				where: {
					hydraLocalParticipantId: rule.hydraLocalParticipantId,
					status: {
						in: [HydraTopupStatus.Preparing, HydraTopupStatus.Pending, HydraTopupStatus.Confirmed],
					},
				},
				select: { id: true, status: true, updatedAt: true, depositTxHash: true },
				orderBy: { updatedAt: 'asc' },
			});
			if (inFlight.length > 0) {
				// Said out loud once it stops looking like a deposit in flight.
				//
				// `Confirmed` leaves this set only when the deposit's script output is
				// seen spent — absorbed, or recovered. A deposit the head never picks
				// up is not rare (a hydra-node considers a deposit only while it is
				// within its window and does not retry a snapshot request that goes
				// unanswered), and its output then sits unspent forever. Auto top-up
				// for that participant was disabled from then on, silently: this cycle
				// skipped every thirty seconds with no log line, the rule stayed Low,
				// and the low-balance webhook fires only on the Healthy -> Low edge,
				// so nobody was told a second time. The in-head balance ran down and
				// L2 escrow operations began failing with the original alert as the
				// only symptom.
				const stalled = inFlight[0];
				if (Date.now() - stalled.updatedAt.getTime() > STALLED_TOPUP_AFTER_MS) {
					logger.warn('hydra-auto-topup: skipping a Low rule because a deposit has been in flight too long', {
						ruleId: rule.id,
						headId: head.id,
						topupId: stalled.id,
						status: stalled.status,
						depositTxHash: stalled.depositTxHash,
						stalledForMs: Date.now() - stalled.updatedAt.getTime(),
						hint: 'recover the deposit from the head, or absorb it, before auto top-up can resume',
					});
				}
				continue;
			}

			const filter: CommitUtxoFilter = rule.assetUnit === 'lovelace' ? 'all' : { unit: rule.assetUnit };
			const result = await executeHydraTopup({
				headId: head.id,
				filter,
				target: { unit: rule.assetUnit, amount: rule.topupAmount },
			});
			logger.info('hydra-auto-topup: submitted low-balance top-up', {
				ruleId: rule.id,
				headId: head.id,
				topupId: result.topupId,
				depositTxHash: result.depositTxHash,
			});
		} catch (error) {
			logger.error('hydra-auto-topup: rule top-up failed', {
				ruleId: rule.id,
				error: error instanceof Error ? error.message : 'Non-error failure',
			});
		}
	}
}
