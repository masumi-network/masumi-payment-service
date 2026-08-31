/**
 * Chain-qualified EVM credit unit: `eip155:<chainId>:<tokenAddress>` — the format
 * the x402 payment path debits (see x402CreditUnit in
 * packages/payment-source-x402/src/pay.ts, which lowercases the asset address).
 */
const EVM_CREDIT_UNIT = /^eip155:\d+:0x[0-9a-fA-F]{40}$/;

/**
 * Anything that LOOKS like it was meant to be an EVM credit unit. Deliberately
 * loose (case-insensitive namespace, any tail) so that near misses are caught
 * rather than stored: see assertCreditUnitIsCanonical.
 */
const EVM_CREDIT_UNIT_ISH = /^eip155:/i;

/**
 * Normalize an admin-supplied credit unit to the form the debit path looks up.
 *
 * The x402 debit lowercases the token address (checksummed and lowercase forms are
 * the same ERC-20 contract), so a credit row stored with a checksummed address —
 * the form explorers and wallets put on the clipboard — could never match and the
 * key would 402 forever despite funded credits. Only EVM-shaped units are touched:
 * Cardano units (policyId+assetName hex, or the literal 'lovelace') are stored
 * verbatim because asset-name hex is case-significant on that side.
 */
export function normalizeCreditUnit(unit: string): string {
	return EVM_CREDIT_UNIT.test(unit) ? unit.toLowerCase() : unit;
}

/**
 * Reject EVM-ish credit units that are not exactly `eip155:<chainId>:0x<40 hex>`.
 *
 * This has to FAIL CLOSED, because the x402 cap is only enforced for units the
 * debit path can find: a near miss (`EIP155:…`, `eip155:8453:native`, a truncated
 * address) would be stored verbatim, never match the lookup, and — since the key
 * then has no rows the enforcement probe recognizes — leave the key spending with
 * no ceiling at all while the dashboard shows it as funded and limited. Storing
 * such a unit is always an operator mistake, so it is better to refuse it at the
 * boundary than to silently disable a spending control.
 *
 * Returns the offending unit, or null when the unit is fine.
 */
export function findNonCanonicalEvmCreditUnit(units: string[]): string | null {
	return units.find((unit) => EVM_CREDIT_UNIT_ISH.test(unit) && !EVM_CREDIT_UNIT.test(unit)) ?? null;
}

/**
 * Merge duplicate units (post-normalization) by summing their amounts, preserving
 * first-seen order. Nothing enforces uniqueness of (apiKeyId, unit) in the ledger,
 * and rows split across duplicates read as a lower balance to any consumer that
 * resolves a single row — so duplicates are collapsed before they are ever created.
 * Throws on negative amounts; a zero row is kept so an explicit zero grant stays
 * visible.
 */
export function consolidateUsageCredits(
	credits: Array<{ unit: string; amount: bigint }>,
): Array<{ unit: string; amount: bigint }> {
	const byUnit = new Map<string, bigint>();
	for (const credit of credits) {
		if (credit.amount < 0n) {
			throw new Error('Invalid amount');
		}
		const unit = normalizeCreditUnit(credit.unit);
		byUnit.set(unit, (byUnit.get(unit) ?? 0n) + credit.amount);
	}
	return Array.from(byUnit.entries()).map(([unit, amount]) => ({ unit, amount }));
}

/** The ledger writes one unit's delta needs. `updateId` null means create a new row. */
export interface CreditDeltaPlan {
	updateId: string | null;
	/** Duplicate rows for the same unit, folded into `updateId`. Delete them. */
	deleteIds: string[];
	/** The unit's balance after the delta. */
	amount: bigint;
}

/**
 * Plan the ledger writes for one unit's delta, across EVERY row that carries it.
 *
 * The ledger has no unique index on (apiKeyId, unit), so a key can hold several rows
 * for one asset: two rows created before the write paths consolidated, or a stale
 * checksummed row beside the canonical lowercase one. Every reader sums them, because
 * the dashboard shows one balance per unit and the x402 debit folds duplicates before
 * it charges. Resolving a single row here left the update path the only one that did
 * not.
 *
 * The visible failure was an edit that could not be saved. 5 ADA + 3 ADA reads as 8,
 * so lowering it to 1 sends -7, and applying that to the first row alone takes 5 to
 * -2: a 400 that rolls back the whole PATCH, for an edit the balance covers twice
 * over. Removing a duplicate was worse than useless: the delta landed on whichever
 * row matched first, so clearing a stale row could take its balance off the live row
 * instead and leave the stale one standing.
 *
 * Folding onto the first row also repairs the duplicates, the same way
 * `runPurchaseCreditInitTransaction` and the x402 debit already do, so a key stops
 * carrying them after the first edit. No guard is needed on the read: the caller runs
 * inside the Serializable transaction that read these rows.
 *
 * Returns null when the delta is not applicable — it would take the unit below zero,
 * or it is a non-positive delta for a unit the key holds no row for.
 */
export function planCreditDelta(
	rows: ReadonlyArray<{ id: string; unit: string; amount: bigint }>,
	unit: string,
	delta: bigint,
): CreditDeltaPlan | null {
	const matching = rows.filter((row) => normalizeCreditUnit(row.unit) === unit);
	if (matching.length === 0) {
		return delta > 0n ? { updateId: null, deleteIds: [], amount: delta } : null;
	}
	const amount = matching.reduce((total, row) => total + row.amount, 0n) + delta;
	if (amount < 0n) {
		return null;
	}
	return { updateId: matching[0].id, deleteIds: matching.slice(1).map((row) => row.id), amount };
}
