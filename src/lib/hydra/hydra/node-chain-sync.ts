/**
 * Sending Init: holding it until a node that reported itself behind the chain
 * catches up, and the command it then sends. Split out of `HydraNode`; the node
 * keeps the budgets as its own constants.
 */
import { logger } from '@masumi/payment-core/logger';
import { HydraTransportError } from './errors';
import type { HydraCommandOptions } from './node-command-channel';

/**
 * Hold until `isChainSynced` stops reporting `false`. Resolves at once when the
 * state is synced or unknown. Rejects as a transport error (the command was
 * never sent, so there is nothing to reconcile) if the node is still behind
 * after `waitMs`.
 *
 * A node behind the chain may refuse Init (`RejectedInputBecauseUnsynced`)
 * or park it (`WaitOnNodeInSync`) until `NodeSynced`. Parking, live on
 * preprod 2026-09-07: Init handed to a node whose Greetings said
 * `CatchingUp`, `NodeSynced` 49s later, then nothing at all — no InitTx
 * posted, no `PostTxOnChainFailed`, no frame — until the observe timeout
 * raised an ambiguous error for a transaction that had never existed.
 * So a node that has positively said it is behind is waited out first.
 * Unknown sync state (no Greetings yet) sends as before: only a reported
 * "behind" holds, and holding on silence would stall every fresh socket.
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

/** Init is done once the head is Initializing or already past it. */
export function initCommand(timeoutMs: number): HydraCommandOptions {
	return {
		command: 'Init',
		payload: { tag: 'Init' },
		timeoutMs,
		timeoutMessage: `Head did not reach Initializing within ${Math.round(
			timeoutMs / 1000,
		)}s of Init; reconcile the possibly submitted InitTx before retrying`,
		isComplete: (message) =>
			message.tag === 'HeadIsInitializing' ||
			message.tag === 'HeadIsOpen' ||
			(message.tag === 'Greetings' && (message.headStatus === 'Initializing' || message.headStatus === 'Open')),
	};
}
