/**
 * What happens after this service disables a head on its own (status
 * persistence failed and the head was failed closed).
 *
 * A disabled head is invisible to this side, but its node keeps co-signing, so
 * the counterparty keeps locking funds in it. So: try the operator's re-enable
 * once (it re-proves the InitTx on L1 before the head is used again). If that
 * fails, or the head fails closed again soon after, stop the node, so the
 * counterparty sees a disconnected peer and routes to L1.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { setOwnHeadNodeRunning } from '@/services/hydra-host/own-node-control';

/** A head that fails closed again within this window after an automatic re-enable is paused, not retried. */
export const HYDRA_AUTO_RECOVERY_COOLDOWN_MS = 15 * 60 * 1000;

export type AutoDisableRecoveryOutcome = 'not-failed-closed' | 'still-enabled' | 're-enabled' | 'paused';

export interface AutoDisableRecoveryDeps {
	reEnable: (hydraHeadId: string) => Promise<void>;
	pause: (hydraHeadId: string, reason: string) => Promise<unknown>;
	now: () => number;
}

const defaultDeps: AutoDisableRecoveryDeps = {
	// Loaded on demand: the route module pulls in the whole head API, and the
	// connection manager must not depend on it at import time.
	reEnable: async (hydraHeadId) => {
		const { updateHydraHeadEnabledState } = await import('@/routes/api/hydra/head');
		await updateHydraHeadEnabledState(hydraHeadId, true);
	},
	pause: async (hydraHeadId, reason) => await setOwnHeadNodeRunning(hydraHeadId, false, reason),
	now: () => Date.now(),
};

const lastAutoReEnableAt = new Map<string, number>();
/**
 * Heads this process disabled itself, by failing closed from an enabled state.
 * Only these are re-enabled automatically: a head the operator disabled, or one
 * a rollback quarantined for explicit recovery, must stay as it is.
 */
const failedClosedHeads = new Set<string>();

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

/** Pause, unless the head came back meanwhile (an operator re-enable can win the race). */
async function pauseIfStillDisabled(
	hydraHeadId: string,
	reason: string,
	deps: AutoDisableRecoveryDeps,
): Promise<AutoDisableRecoveryOutcome> {
	if ((await isHeadEnabled(hydraHeadId)) !== false) return 'still-enabled';
	logger.error(`[HydraAutoRecovery] ${reason}; pausing the node`, { hydraHeadId });
	await deps.pause(hydraHeadId, reason);
	return 'paused';
}

export async function recoverOrPauseAutoDisabledHead(
	hydraHeadId: string,
	deps: AutoDisableRecoveryDeps = defaultDeps,
): Promise<AutoDisableRecoveryOutcome> {
	// Consumed up front, so a second recovery for the same failure does nothing.
	if (!failedClosedHeads.delete(hydraHeadId)) return 'not-failed-closed';
	if ((await isHeadEnabled(hydraHeadId)) !== false) return 'still-enabled';

	const lastAttempt = lastAutoReEnableAt.get(hydraHeadId);
	if (lastAttempt !== undefined && deps.now() - lastAttempt < HYDRA_AUTO_RECOVERY_COOLDOWN_MS) {
		return await pauseIfStillDisabled(hydraHeadId, 'head failed closed again soon after an automatic re-enable', deps);
	}

	lastAutoReEnableAt.set(hydraHeadId, deps.now());
	try {
		await deps.reEnable(hydraHeadId);
		logger.warn('[HydraAutoRecovery] re-enabled a head after it failed closed', { hydraHeadId });
		return 're-enabled';
	} catch (error) {
		logger.error('[HydraAutoRecovery] automatic re-enable failed', {
			hydraHeadId,
			error: error instanceof Error ? error.message : String(error),
		});
		return await pauseIfStillDisabled(hydraHeadId, 'automatic re-enable failed after the head failed closed', deps);
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
	return await recoverOrPauseAutoDisabledHead(hydraHeadId, deps);
}

/** Test seam: forget recorded attempts. */
export function resetAutoDisableRecoveryState(): void {
	lastAutoReEnableAt.clear();
	failedClosedHeads.clear();
}
