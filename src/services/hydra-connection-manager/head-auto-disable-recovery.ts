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

export type AutoDisableRecoveryOutcome = 'still-enabled' | 're-enabled' | 'paused';

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

export async function recoverOrPauseAutoDisabledHead(
	hydraHeadId: string,
	deps: AutoDisableRecoveryDeps = defaultDeps,
): Promise<AutoDisableRecoveryOutcome> {
	const head = await prisma.hydraHead.findUnique({ where: { id: hydraHeadId }, select: { isEnabled: true } });
	// Gone, or the durable disable never landed: nothing to recover from.
	if (!head || head.isEnabled) return 'still-enabled';

	const lastAttempt = lastAutoReEnableAt.get(hydraHeadId);
	if (lastAttempt !== undefined && deps.now() - lastAttempt < HYDRA_AUTO_RECOVERY_COOLDOWN_MS) {
		logger.error('[HydraAutoRecovery] head failed closed again soon after an automatic re-enable; pausing its node', {
			hydraHeadId,
		});
		await deps.pause(hydraHeadId, 'head failed closed again after automatic re-enable');
		return 'paused';
	}

	lastAutoReEnableAt.set(hydraHeadId, deps.now());
	try {
		await deps.reEnable(hydraHeadId);
		logger.warn('[HydraAutoRecovery] re-enabled a head after it failed closed', { hydraHeadId });
		return 're-enabled';
	} catch (error) {
		logger.error('[HydraAutoRecovery] automatic re-enable failed; pausing the node', {
			hydraHeadId,
			error: error instanceof Error ? error.message : String(error),
		});
		await deps.pause(hydraHeadId, 'automatic re-enable failed after the head failed closed');
		return 'paused';
	}
}

/** Test seam: forget recorded attempts. */
export function resetAutoDisableRecoveryState(): void {
	lastAutoReEnableAt.clear();
}
