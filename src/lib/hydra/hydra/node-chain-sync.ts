/**
 * Holding Init until a node that reported itself behind the chain catches up.
 * Split out of `HydraNode`; the node keeps the budgets as its own constants.
 */
import { logger } from '@masumi/payment-core/logger';
import { HydraTransportError } from './errors';

/**
 * Hold until `isChainSynced` stops reporting `false`. Resolves at once when the
 * state is synced or unknown. Rejects as a transport error (the command was
 * never sent, so there is nothing to reconcile) if the node is still behind
 * after `waitMs`.
 */
export async function awaitChainSyncedForInit(options: {
	isChainSynced: () => boolean | undefined;
	headId: string | undefined;
	waitMs: number;
	pollMs: number;
}): Promise<void> {
	const { isChainSynced, headId, waitMs, pollMs } = options;
	logger.info('[HydraNode] Node reports it is catching up; holding Init until it is synced', { headId });
	const deadline = Date.now() + waitMs;
	while (isChainSynced() === false) {
		if (Date.now() >= deadline) {
			throw new HydraTransportError(
				`Init not sent: hydra-node still reports it is behind the chain after ${Math.round(
					waitMs / 1000,
				)}s; retry once it reports synced`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
