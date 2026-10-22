/**
 * The commands that settle a closed head: Close, Fanout and PartialFanout.
 *
 * Split from `node.ts`, which is at the 750-line limit. Each returns the
 * options `sendHydraCommandAndWait` needs and holds no session state.
 */

import type { HydraCommandOptions } from './node-command-channel';
import type { HydraFanoutRemainingUtxo } from './fanout-head-state';

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
 */
export function partialFanoutCommand(utxoToFanout: HydraFanoutRemainingUtxo, timeoutMs: number): HydraCommandOptions {
	const selectedReferences = new Set(Object.keys(utxoToFanout).map((reference) => reference.toLowerCase()));
	const selectedContents = new Set(Object.values(utxoToFanout).map(canonicalOutputContent));
	return {
		command: 'PartialFanout',
		payload: { tag: 'PartialFanout', utxoToFanout },
		timeoutMs,
		timeoutMessage: 'Hydra PartialFanout outcome was not observed before the lifecycle deadline',
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

/**
 * One string per output content. The selection holds schema-parsed outputs
 * (BigInt quantities, absent optional fields) and a frame holds raw JSON
 * (numbers, explicit nulls), so both are reduced to sorted keys, quantities
 * as decimal strings and no null fields.
 */
export function canonicalOutputContent(output: unknown): string {
	const canonical = (value: unknown): unknown => {
		if (typeof value === 'bigint' || typeof value === 'number') return value.toString();
		if (Array.isArray(value)) return value.map(canonical);
		if (typeof value !== 'object' || value == null) return value;
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry != null)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	};
	return JSON.stringify(canonical(output));
}
