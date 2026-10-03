/**
 * Shared L2 (in-head) escrow datum validation, used by BOTH Hydra sync observers:
 *
 *   - the fallback event observer `syncHydraDatumStateFromConfirmedTx`
 *     (`src/services/hydra-connection-manager`), and
 *   - the periodic reconciler `reconcileHydraHeadEscrowStates`
 *     (`packages/payment-source-v2/.../hydra-reconcile`).
 *
 * Both observe the SAME in-head escrow UTxO/datum and must apply the SAME trust
 * boundary — otherwise a datum accepted by one path is rejected (or interpreted
 * differently) by the other, and which path observes first decides the row's fate
 * nondeterministically. This module is the single source of truth for:
 *
 *   1. datum `state` → `OnChainState` (strict 1:1, the canonical mapping);
 *   2. datum-vs-request field agreement (spoofing guard); and
 *   3. initial-lock money-safety validation (amounts, collateral, resultHash,
 *      cooldowns) — the L2 mirror of L1's `updateInitial*Transaction`.
 *
 * Pure + mesh-free on purpose (type-only datum import, no `@meshsdk/*`, no
 * Blockfrost) so it is importable from both the V1-pinned `src/` tree and the
 * V2 `payment-source-v2` package without violating the ADR-0005 mesh pinning.
 */
import { OnChainState } from '@/generated/prisma/client';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { checkPaymentAmountsMatch } from '@masumi/payment-core/payment-amounts';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';

/**
 * Strict 1:1 datum-state → OnChainState. This is the inverse of the canonical
 * `smartContractStateEqualsOnChainState` (payment-core). Terminal/invalid states
 * (the UTxO would be spent, not present in the head) return null. Deliberately
 * does NOT fold `FundsLocked + resultHash → ResultSubmitted`: on a VALID datum the
 * `state` field is authoritative (SubmitResult sets state=ResultSubmitted), and a
 * `FundsLocked` datum that nonetheless carries a resultHash is a spoof, caught by
 * `validateL2InitialLock` — not silently reinterpreted.
 */
export function smartContractStateToOnChainState(state: SmartContractState): OnChainState | null {
	switch (state) {
		case SmartContractState.FundsLocked:
			return OnChainState.FundsLocked;
		case SmartContractState.ResultSubmitted:
			return OnChainState.ResultSubmitted;
		case SmartContractState.RefundRequested:
			return OnChainState.RefundRequested;
		case SmartContractState.Disputed:
			return OnChainState.Disputed;
		case SmartContractState.WithdrawAuthorized:
			return OnChainState.WithdrawAuthorized;
		case SmartContractState.RefundAuthorized:
			return OnChainState.RefundAuthorized;
		default:
			return null;
	}
}

/** The request fields the datum must agree with (excluding state). */
export interface ReconcileMatchFields {
	inputHash: string | null;
	submitResultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	payByTime: bigint | null;
	buyerAddress: string | null;
	sellerAddress: string | null;
	/** `undefined` means the request does not know this address yet. */
	buyerReturnAddress: string | null | undefined;
	/** `undefined` means the request does not know this address yet. */
	sellerReturnAddress: string | null | undefined;
	buyerVkey: string | null;
	sellerVkey: string | null;
}

/**
 * Defense-in-depth beyond the cryptographic blockchainIdentifier match: the datum
 * must also agree with the request on inputHash, the time fields and both party
 * vkeys before we advance money-state. (State intentionally NOT checked — the
 * whole point is that it changed.)
 *
 * A field is only compared when the request actually carries it:
 *   - a null request vkey means "unknown", not "mismatch" — on the L2-native lock
 *     path the payment-side `BuyerWallet` (→ buyerVkey) is frequently null and
 *     must not block reconciliation; and
 *   - a null request `payByTime` (legacy pre-backfill rows) is accepted rather
 *     than forced to equal a datum `payByTime` of 0 that never occurs.
 * This mirrors the L1 tx-sync field check
 * (`src/services/transactions/tx-sync/tx/index.ts`), which guards each vkey
 * comparison with a `Wallet != null` precondition and treats null `payByTime` as
 * "accept".
 */
export function datumMatchesRequest(decoded: DecodedV1ContractDatum, request: ReconcileMatchFields): boolean {
	return (
		decoded.inputHash === request.inputHash &&
		BigInt(decoded.resultTime) === BigInt(request.submitResultTime) &&
		BigInt(decoded.unlockTime) === BigInt(request.unlockTime) &&
		BigInt(decoded.externalDisputeUnlockTime) === BigInt(request.externalDisputeUnlockTime) &&
		(request.payByTime == null || BigInt(decoded.payByTime) === BigInt(request.payByTime)) &&
		(request.buyerAddress == null || decoded.buyerAddress === request.buyerAddress) &&
		(request.sellerAddress == null || decoded.sellerAddress === request.sellerAddress) &&
		(request.buyerReturnAddress === undefined || (decoded.buyerReturnAddress ?? null) === request.buyerReturnAddress) &&
		(request.sellerReturnAddress === undefined ||
			(decoded.sellerReturnAddress ?? null) === request.sellerReturnAddress) &&
		(request.buyerVkey == null || decoded.buyerVkey === request.buyerVkey) &&
		(request.sellerVkey == null || decoded.sellerVkey === request.sellerVkey)
	);
}

/** Outcome of {@link validateL2InitialLock}. */
export interface L2InitialLockResult {
	valid: boolean;
	/** Human-readable reason(s) the lock is invalid; null when valid. */
	errorNote: string | null;
}

/**
 * Money-safety validation for an INITIAL in-head lock (derived state
 * `FundsLocked`) — the L2 mirror of L1 `updateInitialPaymentTransaction` /
 * `updateInitialPurchaseTransaction`. An in-head output is CREATED, not spent, so
 * the validator never ran; the locking party freely chose the amount, collateral
 * and datum. Without this, a malicious buyer could lock an underfunded escrow, or
 * set `collateralReturnLovelace` above the locked ADA (permanently bricking the
 * seller's withdraw), and both sync paths would happily mark it `FundsLocked`.
 *
 * Checks (all must hold): resultHash absent, both cooldowns zero, per-asset
 * amounts + collateral within bounds ({@link checkPaymentAmountsMatch}), and the
 * non-lovelace token count agrees. Callers pass their own `expectedFunds`
 * (payment → RequestedFunds, purchase → PaidFunds). On failure the caller must
 * advance the row to `FundsOrDatumInvalid` rather than `FundsLocked`.
 *
 * `expectedFunds`/`outputAmounts` are defensively copied before the (mutating)
 * amount check, so callers may pass their live arrays.
 */
export function validateL2InitialLock(
	decoded: DecodedV1ContractDatum,
	expectedFunds: Array<{ unit: string; amount: bigint }>,
	outputAmounts: Array<{ unit: string; quantity: string }>,
	confirmationTimeMs: bigint | number | null,
): L2InitialLockResult {
	const errors: string[] = [];

	if (decoded.resultHash != null) {
		errors.push('Result hash was set on an initial lock. This likely is a spoofing attempt.');
	}
	if (BigInt(decoded.buyerCooldownTime) !== 0n) {
		errors.push('Buyer cooldown time is not 0. This likely is a spoofing attempt.');
	}
	if (BigInt(decoded.sellerCooldownTime) !== 0n) {
		errors.push('Seller cooldown time is not 0. This likely is a spoofing attempt.');
	}
	if (confirmationTimeMs == null) {
		errors.push('Hydra confirmation time is unavailable, so payByTime cannot be verified.');
	} else if (BigInt(confirmationTimeMs) > BigInt(decoded.payByTime)) {
		errors.push('Hydra lock was confirmed after payByTime.');
	}

	const isNonLovelace = (unit: string) => unit !== '' && unit.toLowerCase() !== 'lovelace';
	const expectedTokenCount = expectedFunds.filter((x) => isNonLovelace(x.unit)).length;
	const actualTokenCount = outputAmounts.filter((x) => isNonLovelace(x.unit)).length;
	if (expectedTokenCount !== actualTokenCount) {
		errors.push('Token counts do not match. This likely is a spoofing attempt.');
	}

	// checkPaymentAmountsMatch mutates unit fields in place — pass copies.
	const amountsMatch = checkPaymentAmountsMatch(
		expectedFunds.map((x) => ({ ...x })),
		outputAmounts.map((y) => ({ ...y })),
		decoded.collateralReturnLovelace,
	);
	if (!amountsMatch) {
		errors.push('Payment amounts do not match. This likely is a spoofing attempt.');
	}

	return { valid: errors.length === 0, errorNote: errors.length === 0 ? null : errors.join(' ') };
}
