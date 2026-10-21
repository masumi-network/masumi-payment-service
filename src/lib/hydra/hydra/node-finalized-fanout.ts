/**
 * The finalized fanout output map a node reported, and the L1-keyed form of it.
 *
 * hydra-node 2.4.1 builds `HeadIsFinalized.finalizedUTxO` from two sources. The
 * outputs of the terminal L1 step are keyed by their L1 reference. The outputs
 * that earlier partial steps distributed are keyed by their in-head (L2)
 * reference instead, because the node removes them from its remaining set by
 * content and keeps the snapshot's keys (`HeadLogic.hs:1601` at 2.4.1). An L2
 * key names no L1 output, so it can prove nothing on chain and cannot be the
 * target of an ownership handoff.
 *
 * Such a map is therefore held back until `adoptL1Binding` replaces those
 * entries with the L1 outputs they became. A map with no in-head key (a fanout
 * that fit in one transaction) is usable as reported.
 */

import { HydraProtocolError } from './errors';
import { stringMapsEqual } from './node-frames';
import { finalizedUtxoOf, headIsFinalizedMessageSchema } from './schemas';
import { serializeHydraSnapshotOutput, type VerifiedHydraSnapshot } from './snapshot-verification';

export type FinalizedFanoutBindingInput = {
	/** The map exactly as hydra-node reported it. */
	finalizedOutputs: ReadonlyMap<string, string>;
	/** Every in-head reference of the final snapshot; a reported key in this set is an L2 key. */
	inHeadReferences: ReadonlySet<string>;
};

function inHeadReferencesOf(snapshot: VerifiedHydraSnapshot): Set<string> {
	return new Set([...snapshot.outputs.keys(), ...snapshot.committedOutputs.keys(), ...snapshot.decommitOutputs.keys()]);
}

function sameValueMultiset(left: Iterable<string>, right: Iterable<string>): boolean {
	const counts = new Map<string, number>();
	for (const output of left) counts.set(output, (counts.get(output) ?? 0) + 1);
	for (const output of right) {
		const count = counts.get(output);
		if (!count) return false;
		if (count === 1) counts.delete(output);
		else counts.set(output, count - 1);
	}
	return counts.size === 0;
}

export class FinalizedFanoutState {
	/** Shared between live and replay sightings; they must never disagree. */
	private reported: Map<string, string> | undefined;
	private l1Bound: Map<string, string> | undefined;

	/**
	 * Record the map from a live frame or a replayed one. Both sockets can report
	 * it, and replay re-reports it on every reconnect, so an identical map keeps
	 * any binding already adopted for it.
	 */
	record(message: unknown, assertExpectedHeadId: (parsed: { headId: string }) => void): void {
		const parsedMessage = headIsFinalizedMessageSchema.parse(message);
		assertExpectedHeadId(parsedMessage);
		const fanoutOutputs = new Map<string, string>();
		for (const [reference, output] of Object.entries(finalizedUtxoOf(parsedMessage))) {
			fanoutOutputs.set(reference.toLowerCase(), serializeHydraSnapshotOutput(output));
		}
		if (this.reported && !stringMapsEqual(this.reported, fanoutOutputs)) {
			throw new HydraProtocolError('Hydra history equivocated on the finalized L1 fanout output map');
		}
		this.reported = fanoutOutputs;
	}

	clear(): void {
		this.reported = undefined;
		this.l1Bound = undefined;
	}

	/** The map keyed by L1 references only, or undefined while it still needs binding. */
	l1Outputs(snapshot: VerifiedHydraSnapshot): Map<string, string> | undefined {
		if (!this.reported) return undefined;
		const inHead = inHeadReferencesOf(snapshot);
		if (![...this.reported.keys()].some((reference) => inHead.has(reference))) return this.reported;
		return this.l1Bound;
	}

	/** What a binder needs, or null when there is nothing (left) to bind. */
	bindingInput(snapshot: VerifiedHydraSnapshot): FinalizedFanoutBindingInput | null {
		if (!this.reported || this.l1Bound) return null;
		const inHeadReferences = inHeadReferencesOf(snapshot);
		if (![...this.reported.keys()].some((reference) => inHeadReferences.has(reference))) return null;
		return { finalizedOutputs: this.reported, inHeadReferences };
	}

	/**
	 * Adopt a binding only if it renames in-head keys and changes nothing else:
	 * every L1-keyed entry kept as reported, the same output values with the same
	 * counts, and no in-head key left. Returns whether it was adopted.
	 */
	adoptL1Binding(snapshot: VerifiedHydraSnapshot, bound: ReadonlyMap<string, string>): boolean {
		const input = this.bindingInput(snapshot);
		if (!input) return false;
		for (const [reference, output] of input.finalizedOutputs) {
			if (!input.inHeadReferences.has(reference) && bound.get(reference) !== output) return false;
		}
		if ([...bound.keys()].some((reference) => input.inHeadReferences.has(reference))) return false;
		if (!sameValueMultiset(bound.values(), input.finalizedOutputs.values())) return false;
		this.l1Bound = new Map(bound);
		return true;
	}
}
