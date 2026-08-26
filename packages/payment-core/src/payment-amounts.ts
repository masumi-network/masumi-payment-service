import { CONSTANTS } from './config';

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
 * NOTE: mutates `x.unit`/`y.unit` in place (normalises 'lovelace' → '') — callers
 * that must not mutate their inputs should pass copies.
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
	// Bound the collateral against the actually-locked lovelace unconditionally.
	// Every seller spend path is gated on-chain by
	// `lovelace_of(input) >= collateral_return_lovelace` (SubmitResult / Withdraw
	// in both smart-contracts/payment{,-v2}/validators/vested_pay.ak), so a datum
	// whose collateral exceeds the locked ADA permanently bricks the seller. The
	// per-asset check below only enforces this when the request carries a
	// lovelace line item; a token-only request would otherwise skip it, letting a
	// malicious buyer lock such a datum and defraud the seller of their work.
	const lockedLovelace = actualAmounts
		.filter((y) => y.unit === '' || y.unit.toLowerCase() == 'lovelace')
		.reduce((sum, y) => sum + BigInt(y.quantity), 0n);
	if (collateralReturn > lockedLovelace) {
		return false;
	}
	return expectedAmounts.every((x) => {
		if (x.unit.toLowerCase() == 'lovelace') {
			x.unit = '';
		}
		const existingAmount = actualAmounts.find((y) => {
			if (y.unit.toLowerCase() == 'lovelace') {
				y.unit = '';
			}
			return y.unit == x.unit;
		});
		if (existingAmount == null) return false;
		//allow for some overpayment to handle min lovelace requirements
		if (x.unit == '') {
			return x.amount <= BigInt(existingAmount.quantity) - collateralReturn;
		}
		//require exact match for non-lovelace amounts
		return x.amount == BigInt(existingAmount.quantity);
	});
}
