import { CONSTANTS } from './config';

/** ADA uses an empty unit; native asset units are hexadecimal strings. */
export function canonicalPaymentUnit(unit: string) {
	const lowercaseUnit = unit.toLowerCase();
	return lowercaseUnit === 'lovelace' ? '' : lowercaseUnit;
}

/**
 * Does the value actually locked at the script address satisfy what the request
 * asked for (per-asset amounts) AND keep the collateral-return within bounds?
 *
 * This is pure (only reads CONSTANTS) and mesh-free on purpose: it lives in
 * payment-core so BOTH the L1 tx-sync verifier (`src/services/transactions/
 * tx-sync/util`) and the L2 in-head datum validator
 * (`src/utils/logic/l2-datum-validation`) share ONE implementation. Do not fork
 * it — the L1/L2 money-safety guarantee must be identical.
 *
 * Duplicate rows for the same asset are summed before comparison. Input rows
 * are not changed.
 */
export function checkPaymentAmountsMatch(
	expectedAmounts: Array<{ unit: string; amount: bigint }>,
	actualAmounts: Array<{ unit: string; quantity: string }>,
	collateralReturn: bigint,
) {
	if (collateralReturn < 0n) {
		return false;
	}
	if (collateralReturn > 0n && collateralReturn < CONSTANTS.MIN_COLLATERAL_LOVELACE) {
		return false;
	}
	const expectedByUnit = new Map<string, bigint>();
	for (const { unit, amount } of expectedAmounts) {
		const canonicalUnit = canonicalPaymentUnit(unit);
		expectedByUnit.set(canonicalUnit, (expectedByUnit.get(canonicalUnit) ?? 0n) + amount);
	}

	const actualByUnit = new Map<string, bigint>();
	for (const { unit, quantity } of actualAmounts) {
		let parsedQuantity: bigint;
		try {
			parsedQuantity = BigInt(quantity);
		} catch {
			return false;
		}
		const canonicalUnit = canonicalPaymentUnit(unit);
		actualByUnit.set(canonicalUnit, (actualByUnit.get(canonicalUnit) ?? 0n) + parsedQuantity);
	}

	// Bound the collateral against the actually-locked lovelace unconditionally.
	// Every seller spend path is gated on-chain by
	// `lovelace_of(input) >= collateral_return_lovelace` (SubmitResult / Withdraw
	// in both smart-contracts/payment{,-v2}/validators/vested_pay.ak), so a datum
	// whose collateral exceeds the locked ADA permanently bricks the seller. The
	// per-asset check below only enforces this when the request carries a
	// lovelace line item; a token-only request would otherwise skip it, letting a
	// malicious buyer lock such a datum and defraud the seller of their work.
	const lockedLovelace = actualByUnit.get('') ?? 0n;
	if (collateralReturn > lockedLovelace) {
		return false;
	}
	for (const [unit, expectedAmount] of expectedByUnit) {
		const actualAmount = actualByUnit.get(unit);
		if (actualAmount == null) return false;
		// Allow ADA overpayment to cover the minimum UTxO requirement.
		if (unit === '') {
			if (expectedAmount > actualAmount - collateralReturn) return false;
		} else if (expectedAmount !== actualAmount) {
			// Native assets must match exactly.
			return false;
		}
	}
	return true;
}
