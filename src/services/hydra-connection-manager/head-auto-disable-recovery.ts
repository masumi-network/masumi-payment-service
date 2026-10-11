/**
 * What happens after this service disables a head on its own (status
 * persistence failed and the head was failed closed).
 *
 * The head's node stays live: it keeps co-signing, so L2 refunds and
 * withdrawals still go through, and it can contest a close. But this side no
 * longer observes the head, so payments the counterparty locks in it meanwhile
 * fail and are refunded. To keep that window short, try the operator's
 * re-enable once (it re-proves the InitTx on L1 before the head is used again).
 * A head that fails closed again soon after stays disabled for the operator.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

/** A head that fails closed again within this window after an automatic re-enable is left to the operator. */
export const HYDRA_AUTO_RECOVERY_COOLDOWN_MS = 15 * 60 * 1000;

export type AutoDisableRecoveryOutcome = 'not-failed-closed' | 'still-enabled' | 're-enabled' | 'cooldown' | 'failed';

export interface AutoDisableRecoveryDeps {
	reEnable: (hydraHeadId: string) => Promise<void>;
	now: () => number;
}

const defaultDeps: AutoDisableRecoveryDeps = {
	// Loaded on demand: the route module pulls in the whole head API, and the
	// connection manager must not depend on it at import time.
	reEnable: async (hydraHeadId) => {
		const { updateHydraHeadEnabledState } = await import('@/routes/api/hydra/head');
		await updateHydraHeadEnabledState(hydraHeadId, true);
	},
	now: () => Date.now(),
};

const lastAutoReEnableAt = new Map<string, number>();
/**
 * Heads this process disabled itself, by failing closed from an enabled state.
 * Only these are re-enabled automatically: a head the operator disabled, or one
 * a rollback quarantined for explicit recovery, must stay as it is.
 */
const failedClosedHeads = new Set<string>();
const recoveringHeads = new Set<string>();

export function markHeadFailedClosed(hydraHeadId: string): void {
	failedClosedHeads.add(hydraHeadId);
}

/** Drop the mark: the head's disabled state is now someone else's decision. */
export function forgetHeadFailedClosed(hydraHeadId: string): void {
	failedClosedHeads.delete(hydraHeadId);
}

async function isHeadEnabled(hydraHeadId: string): Promise<boolean | null> {
	const head = await prisma.hydraHead.findUnique({ where: { id: hydraHeadId }, select: { isEnabled: true } });
	return head?.isEnabled ?? null;
}

export async function recoverAutoDisabledHead(
	hydraHeadId: string,
	deps: AutoDisableRecoveryDeps = defaultDeps,
): Promise<AutoDisableRecoveryOutcome> {
	// One recovery per head at a time: a second one for the same failure does nothing.
	if (!failedClosedHeads.has(hydraHeadId) || recoveringHeads.has(hydraHeadId)) return 'not-failed-closed';
	recoveringHeads.add(hydraHeadId);
	try {
		return await recoverMarkedHead(hydraHeadId, deps);
	} finally {
		recoveringHeads.delete(hydraHeadId);
	}
}

async function recoverMarkedHead(
	hydraHeadId: string,
	deps: AutoDisableRecoveryDeps,
): Promise<AutoDisableRecoveryOutcome> {
	if ((await isHeadEnabled(hydraHeadId)) !== false) {
		failedClosedHeads.delete(hydraHeadId);
		return 'still-enabled';
	}

	const lastAttempt = lastAutoReEnableAt.get(hydraHeadId);
	if (lastAttempt !== undefined && deps.now() - lastAttempt < HYDRA_AUTO_RECOVERY_COOLDOWN_MS) {
		logger.error(
			'[HydraAutoRecovery] head failed closed again soon after an automatic re-enable; leaving it disabled',
			{
				hydraHeadId,
			},
		);
		failedClosedHeads.delete(hydraHeadId);
		return 'cooldown';
	}

	// Consumed last, right before the re-enable: an operator disable (or a
	// quarantine) that landed during the reads above has dropped the mark by
	// now. One landing later is caught by the re-enable's own compare-and-set.
	if (!failedClosedHeads.delete(hydraHeadId)) return 'not-failed-closed';
	lastAutoReEnableAt.set(hydraHeadId, deps.now());
	try {
		await deps.reEnable(hydraHeadId);
		logger.warn('[HydraAutoRecovery] re-enabled a head after it failed closed', { hydraHeadId });
		return 're-enabled';
	} catch (error) {
		logger.error('[HydraAutoRecovery] automatic re-enable failed; leaving the head disabled', {
			hydraHeadId,
			error: error instanceof Error ? error.message : String(error),
		});
		return 'failed';
	}
}

/**
 * Next step once the fail-closed teardown and re-read settled. `connected` is
 * what that re-read returned, or null when it threw. Runs outside the head's
 * control queue: re-enable reconciles through that same queue.
 */
export async function continueAfterStatusPersistenceRecovery(
	hydraHeadId: string,
	connected: boolean | null,
	deps: AutoDisableRecoveryDeps = defaultDeps,
): Promise<AutoDisableRecoveryOutcome | null> {
	if (connected === true) return null;
	if (connected === null) {
		// Not known whether the head is still ours to re-enable: the operator decides.
		forgetHeadFailedClosed(hydraHeadId);
		return null;
	}
	return await recoverAutoDisabledHead(hydraHeadId, deps);
}

/** Test seam: forget recorded attempts. */
export function resetAutoDisableRecoveryState(): void {
	lastAutoReEnableAt.clear();
	failedClosedHeads.clear();
	recoveringHeads.clear();
}
