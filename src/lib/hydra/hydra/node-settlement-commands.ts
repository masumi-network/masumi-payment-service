/**
 * The commands that settle a closed head: Close, Fanout and PartialFanout.
 *
 * Split from `node.ts`, which is at the 750-line limit. Each returns the
 * options `sendHydraCommandAndWait` needs and holds no session state.
 */

import type { HydraCommandOptions } from './node-command-channel';
import type { HydraFanoutRemainingUtxo } from './node-fanout-progress';

export function closeCommand(timeoutMs: number): HydraCommandOptions {
	return {
		command: 'Close',
		payload: { tag: 'Close' },
		timeoutMs,
		timeoutMessage: 'Hydra Close outcome was not observed before the lifecycle deadline',
		isComplete: (message) => message.tag === 'HeadIsClosed',
	};
}

/**
 * A plain Fanout. hydra-node 2.4.1 drains a head that does not fit one
 * transaction on its own, in several steps, so the first step already shows
 * the command took effect. Waiting for `HeadIsFinalized` instead would time
 * out on a large head while the node is still draining it correctly.
 */
export function fanoutCommand(timeoutMs: number): HydraCommandOptions {
	return {
		command: 'Fanout',
		payload: { tag: 'Fanout' },
		timeoutMs,
		timeoutMessage: 'Hydra Fanout outcome was not observed before the lifecycle deadline',
		isComplete: (message) => message.tag === 'HeadIsFinalized' || message.tag === 'HeadPartiallyFannedOut',
	};
}

/**
 * Fan out a selection of the remaining UTxO. The node matches it by content
 * against what remains; a selection of everything that remains ends in the
 * final step and `HeadIsFinalized`.
 */
export function partialFanoutCommand(utxoToFanout: HydraFanoutRemainingUtxo, timeoutMs: number): HydraCommandOptions {
	return {
		command: 'PartialFanout',
		payload: { tag: 'PartialFanout', utxoToFanout },
		timeoutMs,
		timeoutMessage: 'Hydra PartialFanout outcome was not observed before the lifecycle deadline',
		isComplete: (message) => message.tag === 'HeadPartiallyFannedOut' || message.tag === 'HeadIsFinalized',
	};
}
