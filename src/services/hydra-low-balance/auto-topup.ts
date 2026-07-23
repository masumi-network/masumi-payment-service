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

			const pending = await prisma.hydraTopup.count({
				where: { hydraLocalParticipantId: rule.hydraLocalParticipantId, status: HydraTopupStatus.Pending },
			});
			if (pending > 0) continue;

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
