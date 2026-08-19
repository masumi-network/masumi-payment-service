/**
 * Noticing when a head's ledger has drifted from the chain it settles on.
 *
 * A Hydra head runs its own ledger, fixed at initialisation from a parameter
 * file, and it does NOT track L1 epochs. Hydra's own guidance is that fees and
 * execution units are safe to zero but "anything that could be reflected in the
 * UTXO is not… altering these could make a head unclosable".
 *
 * That rule is about the file being written correctly. This is about the file
 * going stale. Fanout is an L1 transaction, so every output the head produces
 * must satisfy L1's minimum-ADA rule at fanout time, and value cannot be added
 * to an output on the way out. So if L1 raises `utxoCostPerByte` while a head is
 * open, outputs that were legal when created can be below L1's minimum when they
 * finally leave — and the head becomes impossible to settle. `maxValueSize` has
 * the same shape.
 *
 * The escrow sizing carries roughly 32% of headroom, so a modest rise is
 * survivable. What is not survivable is not knowing: the margin only helps an
 * operator who closes before the gap grows. This is the part that tells them.
 *
 * Pure and provider-free, so the comparison can be tested without a chain.
 */

/** The parameters that decide whether a head's outputs can leave it. */
export type UtxoAffectingParams = {
	/** Lovelace charged per byte of an output. Decides minimum ADA. */
	utxoCostPerByte: number;
	/** Largest value an output may carry. */
	maxValueSize: number;
};

export type ParamDivergence = {
	parameter: keyof UtxoAffectingParams;
	head: number;
	chain: number;
	/**
	 * Whether the difference threatens fanout.
	 *
	 * Only one direction does. A head configured BELOW the chain creates outputs
	 * the chain will later refuse; a head ABOVE it creates outputs the chain
	 * accepts easily, and merely makes commits stricter than they need to be.
	 */
	blocksFanout: boolean;
};

/**
 * How the head's fixed ledger compares with the chain right now.
 *
 * Empty when they agree. Reported for both directions, because a head that is
 * stricter than L1 is worth knowing about too — it rejects commits of UTxOs
 * that are perfectly legal on chain — even though only the other direction can
 * strand funds.
 */
export function findParamDrift(head: UtxoAffectingParams, chain: UtxoAffectingParams): ParamDivergence[] {
	const divergences: ParamDivergence[] = [];
	for (const parameter of ['utxoCostPerByte', 'maxValueSize'] as const) {
		const headValue = head[parameter];
		const chainValue = chain[parameter];
		if (headValue === chainValue) continue;
		divergences.push({
			parameter,
			head: headValue,
			chain: chainValue,
			// utxoCostPerByte: a head charging LESS per byte makes outputs too small
			// for the chain. maxValueSize: a head allowing MORE makes outputs too
			// large for it. Opposite comparisons, same consequence.
			blocksFanout: parameter === 'utxoCostPerByte' ? headValue < chainValue : headValue > chainValue,
		});
	}
	return divergences;
}

/** One operator-facing line per divergence, saying which way it cuts. */
export function describeParamDrift(divergences: readonly ParamDivergence[]): string {
	return divergences
		.map((divergence) => {
			const where = `${divergence.parameter}: head ${divergence.head}, chain ${divergence.chain}`;
			return divergence.blocksFanout
				? `${where} — outputs created in the head may be rejected by L1 when the head is settled, ` +
						'so open heads should be closed before the gap grows'
				: `${where} — the head is stricter than the chain, so it will refuse commits of UTxOs L1 accepts`;
		})
		.join('; ');
}
