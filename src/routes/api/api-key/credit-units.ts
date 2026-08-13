/**
 * Chain-qualified EVM credit unit: `eip155:<chainId>:<tokenAddress>` — the format
 * the x402 payment path debits (see x402CreditUnit in
 * packages/payment-source-x402/src/pay.ts, which lowercases the asset address).
 */
const EVM_CREDIT_UNIT = /^eip155:\d+:0x[0-9a-fA-F]{40}$/;

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
