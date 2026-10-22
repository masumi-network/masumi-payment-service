/**
 * The commands that settle a closed head: Close, Fanout and PartialFanout.
 *
 * Split from `node.ts`, which is at the 750-line limit. Each returns the
 * options `sendHydraCommandAndWait` needs and holds no session state.
 */

import type { HydraCommandOptions } from './node-command-channel';
import type { HydraFanoutRemainingUtxo } from './fanout-head-state';
import { isPostTxFailureOf } from './node-frames';
import { canonicalOutputContent } from './output-content';

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
 *
 * A step is ours only when it distributed part of this selection. The node
 * removes outputs by content, not by reference: of two identical outputs it
 * may report the other one as distributed. So a step counts when it shares a
 * reference or an output content with the selection. A step already in
 * flight that moves an identical output can still settle the command early;
 * the node checks the selection again either way.
 *
 * A failed step is ours only when it tried to distribute exactly this
 * selection. hydra-node 2.4.1 (`emitPartialFanoutStep` in `HeadLogic.hs`)
 * posts the selection itself as `utxoToDistribute`, or the remaining set when
 * the selection is all of it, while its own auto-drain step posts the whole
 * remaining set. A frame without `utxoToDistribute` (a `FanoutTx`, which a
 * whole-head selection becomes) cannot be told apart, so the tag decides.
 */
export function partialFanoutCommand(utxoToFanout: HydraFanoutRemainingUtxo, timeoutMs: number): HydraCommandOptions {
	const selectedReferences = new Set(Object.keys(utxoToFanout).map((reference) => reference.toLowerCase()));
	const selectedContents = new Set(Object.values(utxoToFanout).map(canonicalOutputContent));
	return {
		command: 'PartialFanout',
		payload: { tag: 'PartialFanout', utxoToFanout },
		timeoutMs,
		timeoutMessage: 'Hydra PartialFanout outcome was not observed before the lifecycle deadline',
		ownsPostTxFailure: (failure) => {
			if (!isPostTxFailureOf('PartialFanout', failure)) return false;
			const distributed = failure.utxoToDistribute;
			if (distributed === undefined) return true;
			return (
				distributed.length === selectedReferences.size &&
				distributed.every(
					({ reference, content }) => selectedReferences.has(reference) || selectedContents.has(content),
				)
			);
		},
		isComplete: (message) => {
			if (message.tag === 'HeadIsFinalized') return true;
			if (message.tag !== 'HeadPartiallyFannedOut') return false;
			const distributed = (message as { distributedUTxO?: unknown }).distributedUTxO;
			if (typeof distributed !== 'object' || distributed == null) return false;
			return Object.entries(distributed).some(
				([reference, output]) =>
					selectedReferences.has(reference.toLowerCase()) || selectedContents.has(canonicalOutputContent(output)),
			);
		},
	};
}
