import { HydraHeadStatus, LowBalanceStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getOwnInHeadBalance } from '@/services/hydra-connection-manager/hydra-head-balance';
import { webhookEventsService } from '@/services/webhooks/events.service';

export type HydraLowBalanceAlert = {
	ruleId: string;
	hydraLocalParticipantId: string;
	hydraHeadId: string;
	assetUnit: string;
	thresholdAmount: bigint;
	currentAmount: bigint;
	checkedAt: Date;
};

/**
 * How long a rule stays Low before it will alert again.
 *
 * The alert used to be a pure edge: the row was flipped to Low in one statement
 * and the webhook was queued in another, outside it. Anything between the two —
 * a transient failure inside `queueWebhook`, which the webhook service swallows
 * and logs, or a restart — lost the alert for good, because every later cycle
 * saw the row already Low and took the branch that only refreshes the amount.
 * Nobody was told, and with `topupEnabled` false (the default) nothing else
 * reads the Low state either: the balance runs down and L2 escrow operations
 * start failing with no warning at all.
 *
 * Re-arming on the timestamp makes a dropped alert retry itself, and gives a
 * head that stays low a reminder rather than one message ever.
 */
const LOW_BALANCE_REALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Rule `assetUnit` uses 'lovelace'; the balance snapshot keys ADA as ''. */
function balanceKeyForAssetUnit(assetUnit: string): string {
	const normalized = assetUnit.toLowerCase();
	return normalized === 'lovelace' ? '' : normalized;
}

/**
 * Evaluate every enabled Hydra low-balance rule against its participant's OWN
 * in-head balance and advance each rule's status. Returns the rules that
 * transitioned Healthy/Unknown -> Low this cycle (the once-per-edge alerts);
 * callers emit the webhook. Rules whose head is not Open or has no live snapshot
 * are skipped (balance unknown, not treated as zero) so a disconnected head never
 * produces a false low-balance alert.
 */
export async function evaluateHydraLowBalanceRules(): Promise<HydraLowBalanceAlert[]> {
	const rules = await prisma.hydraLowBalanceRule.findMany({
		where: { enabled: true },
		include: {
			LocalParticipant: { select: { id: true, HydraHead: { select: { id: true, status: true } } } },
		},
	});

	const alerts: HydraLowBalanceAlert[] = [];
	for (const rule of rules) {
		try {
			const head = rule.LocalParticipant.HydraHead;
			if (!head || head.status !== HydraHeadStatus.Open) continue;

			const balance = await getOwnInHeadBalance(head.id);
			if (!balance || !balance.connected) continue;

			const key = balanceKeyForAssetUnit(rule.assetUnit);
			const currentAmount = BigInt(balance.balance.find((asset) => asset.unit.toLowerCase() === key)?.quantity ?? '0');
			const checkedAt = new Date();

			if (currentAmount < rule.thresholdAmount) {
				// Atomic once-only guard: only the cycle that wins this write emits the
				// alert; concurrent cycles just refresh the observed amount.
				//
				// Won by the edge, or by the age of the last alert. Edge alone made
				// the webhook unrecoverable if anything went wrong between this
				// statement and the queueing that follows it, since every later cycle
				// found the row already Low.
				const realertBefore = new Date(checkedAt.getTime() - LOW_BALANCE_REALERT_INTERVAL_MS);
				const transitioned = await prisma.hydraLowBalanceRule.updateMany({
					where: {
						id: rule.id,
						OR: [
							{ status: { not: LowBalanceStatus.Low } },
							{ lastAlertedAt: null },
							{ lastAlertedAt: { lt: realertBefore } },
						],
					},
					data: {
						status: LowBalanceStatus.Low,
						lastKnownAmount: currentAmount,
						lastCheckedAt: checkedAt,
						lastAlertedAt: checkedAt,
					},
				});
				if (transitioned.count === 1) {
					alerts.push({
						ruleId: rule.id,
						hydraLocalParticipantId: rule.hydraLocalParticipantId,
						hydraHeadId: head.id,
						assetUnit: rule.assetUnit,
						thresholdAmount: rule.thresholdAmount,
						currentAmount,
						checkedAt,
					});
				} else {
					await prisma.hydraLowBalanceRule.update({
						where: { id: rule.id },
						data: { lastKnownAmount: currentAmount, lastCheckedAt: checkedAt },
					});
				}
			} else {
				// Healthy (incl. Unknown -> Healthy). Recovery re-arms the next alert.
				await prisma.hydraLowBalanceRule.update({
					where: { id: rule.id },
					data: { status: LowBalanceStatus.Healthy, lastKnownAmount: currentAmount, lastCheckedAt: checkedAt },
				});
			}
		} catch (error) {
			logger.error('hydra-low-balance: rule evaluation failed', {
				ruleId: rule.id,
				error: error instanceof Error ? error.message : 'Non-error failure',
			});
		}
	}
	return alerts;
}

/** Scheduler entry: evaluate rules and fan low-balance transitions to webhooks. */
export async function runHydraLowBalanceMonitoringCycle(): Promise<void> {
	const alerts = await evaluateHydraLowBalanceRules();
	for (const alert of alerts) {
		await webhookEventsService.triggerHydraHeadLowBalance({
			ruleId: alert.ruleId,
			hydraLocalParticipantId: alert.hydraLocalParticipantId,
			hydraHeadId: alert.hydraHeadId,
			assetUnit: alert.assetUnit,
			thresholdAmount: alert.thresholdAmount.toString(),
			currentAmount: alert.currentAmount.toString(),
			checkedAt: alert.checkedAt.toISOString(),
		});
		logger.warn('hydra-low-balance: participant in-head balance is low', {
			ruleId: alert.ruleId,
			hydraHeadId: alert.hydraHeadId,
			assetUnit: alert.assetUnit,
			currentAmount: alert.currentAmount.toString(),
			thresholdAmount: alert.thresholdAmount.toString(),
		});
	}
}
