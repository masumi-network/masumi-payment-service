// Mesh SDK pinning: this file lives in the V2 package and MUST resolve to the
// V2 mesh line (`@meshsdk/core@1.9.0-beta.102`). The helpers here are pure
// (no mesh runtime calls), but the `UTxO` shape we type against is the V2
// one — kept consistent with the rest of the V2 builders. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import type { UTxO } from '@meshsdk/core';

/**
 * A per-tx validity window. Mirrors the `(invalidBefore, invalidAfter)` pair
 * the mesh tx builder accepts via `.invalidBefore(...) / .invalidHereafter(...)`.
 *
 * Both bounds are slot numbers (NOT unix-ms). Convert from time at the caller
 * via `createTxWindow(...)` from `src/services/shared/tx-window.ts`.
 */
export type TxWindowBounds = { invalidBefore: number; invalidAfter: number };

/**
 * Compute the intersection of per-item validity ranges. The batch tx has a
 * SINGLE `[invalidBefore, invalidAfter]` window which must satisfy every
 * item's individual constraints, so:
 *
 *   consensusInvalidBefore = max(item.invalidBefore)
 *   consensusInvalidAfter  = min(item.invalidAfter)
 *
 * Why this matters: Aiken validators frequently call `must_start_after` or
 * `must_be_signed_before` which gate the redeemer behavior on
 * `validity_range.lower_bound / upper_bound`. The batch tx exposes ONE
 * validity range to every spend leg, so the chosen window has to honor every
 * leg's constraint simultaneously.
 *
 * Returns `null` when the intersection is empty (`invalidBefore > invalidAfter`
 * after composition) — items are mutually incompatible and the caller should
 * drop the most constrained item and retry, or fall back to single-item
 * builders for the outliers.
 *
 * @param windows  Per-item validity windows. Empty array returns `null`.
 * @returns        The composed window, or `null` if the intersection is empty.
 */
export function intersectTxWindows(windows: TxWindowBounds[]): TxWindowBounds | null {
	if (windows.length === 0) return null;

	let invalidBefore = windows[0].invalidBefore;
	let invalidAfter = windows[0].invalidAfter;

	for (let i = 1; i < windows.length; i++) {
		const w = windows[i];
		if (w.invalidBefore > invalidBefore) invalidBefore = w.invalidBefore;
		if (w.invalidAfter < invalidAfter) invalidAfter = w.invalidAfter;
	}

	if (invalidBefore > invalidAfter) return null;
	return { invalidBefore, invalidAfter };
}

/** Internal helper: read the lovelace quantity from a UTxO's asset list. */
function getLovelace(utxo: UTxO): bigint {
	const lovelaceAsset = utxo.output.amount.find((asset) => asset.unit === 'lovelace' || asset.unit === '');
	if (lovelaceAsset == null) return 0n;
	try {
		return BigInt(lovelaceAsset.quantity);
	} catch {
		return 0n;
	}
}

/** Internal helper: true iff the UTxO holds only the implicit lovelace asset. */
function isPureLovelace(utxo: UTxO): boolean {
	const amount = utxo.output.amount;
	if (amount.length === 0) return false;
	for (const asset of amount) {
		if (asset.unit !== 'lovelace' && asset.unit !== '') return false;
	}
	return true;
}

/** Canonical reference string for a UTxO — must match the format the builders use. */
function refKey(input: { txHash: string; outputIndex: number }): string {
	return `${input.txHash}#${input.outputIndex}`;
}

/**
 * Pick a collateral UTxO that is NOT also a spending input. Returns the
 * SMALLEST qualifying pure-ADA UTxO so we don't burn a fat UTxO as
 * collateral.
 *
 * The `requiredLovelace` floor accounts for Conway's `collateralPercentage`
 * (typically 150) applied to `sum_of_redeemer_fees`. For batches with N
 * script inputs, `ex_units` sum across redeemers and the required collateral
 * grows with N, so the caller should pass
 * `requiredLovelace = max(5_000_000n, estimatedTotalCollateral)`. The helper
 * itself does NOT compute collateral from `ex_units` — that math lives in
 * `computeCollateralFromExUnits` and is wired in by the caller AFTER the
 * first `evaluateTx` pass returns budgets.
 *
 * Conway phase-1 rejects a tx whose collateral UTxO reference is ALSO in
 * the spending input set. We filter against `excludeSpendingInputs` to honor
 * that. Collateral overlap manifests as an opaque
 * `EvaluationFailure: ScriptFailures: {}` from ogmios — pre-filtering here
 * keeps the diagnostic on the caller's side instead.
 *
 * Returns `null` (NOT throws) — the caller decides how to handle a missing
 * collateral (e.g. shrink the batch, fall back to single-item, surface to
 * operator).
 *
 * @param utxos                   Wallet UTxOs to choose from.
 * @param excludeSpendingInputs   References that MUST NOT also be the collateral.
 * @param requiredLovelace        Minimum lovelace; defaults to 5_000_000n.
 * @returns                       A qualifying UTxO, or `null` if none match.
 */
export function pickBatchCollateral(
	utxos: UTxO[],
	excludeSpendingInputs: Array<{ txHash: string; outputIndex: number }>,
	requiredLovelace: bigint = 5_000_000n,
): UTxO | null {
	const excludeKeys = new Set<string>();
	for (const ref of excludeSpendingInputs) {
		excludeKeys.add(refKey(ref));
	}

	const candidates: Array<{ utxo: UTxO; lovelace: bigint }> = [];
	for (const utxo of utxos) {
		if (excludeKeys.has(refKey(utxo.input))) continue;
		if (!isPureLovelace(utxo)) continue;
		const lovelace = getLovelace(utxo);
		if (lovelace < requiredLovelace) continue;
		candidates.push({ utxo, lovelace });
	}

	if (candidates.length === 0) return null;

	// Smallest qualifying first.
	candidates.sort((a, b) => {
		if (a.lovelace < b.lovelace) return -1;
		if (a.lovelace > b.lovelace) return 1;
		return 0;
	});
	return candidates[0].utxo;
}

/**
 * Internal: parse a decimal value (number or string) into a scaled bigint.
 * Returns `value * 10^scaleDigits` rounded toward zero. Designed for
 * Cardano protocol-parameter decimals like price_mem = "0.0577" which are
 * exact rationals on-chain but arrive at us as decimal strings.
 *
 * Precision: we pad to 20 fractional digits which is well beyond any
 * realistic protocol-parameter precision. Any fractional digits beyond 20
 * are truncated (NOT rounded) — acceptable for a safety-margin computation,
 * and the caller is expected to apply a multiplier (e.g. 1.5x) for headroom.
 */
function decimalToScaled(value: number | string, scaleDigits: number): bigint {
	const s = typeof value === 'number' ? value.toString() : value;
	// Handle scientific notation (e.g. "1e-3") by normalizing through Number.
	// Mesh / blockfrost don't emit scientific notation today but be defensive.
	const normalized = s.includes('e') || s.includes('E') ? Number(s).toFixed(20) : s;

	const isNegative = normalized.startsWith('-');
	const unsigned = isNegative ? normalized.slice(1) : normalized;
	const [whole, frac = ''] = unsigned.split('.');

	const cappedFracDigits = Math.min(scaleDigits, 20);
	const fracPadded = (frac + '0'.repeat(scaleDigits)).slice(0, cappedFracDigits);
	const padTail = '0'.repeat(scaleDigits - cappedFracDigits);

	const combined = (whole === '' ? '0' : whole) + fracPadded + padTail;
	const result = BigInt(combined);
	return isNegative ? -result : result;
}

/** Internal: ceil-div for non-negative bigints. */
function ceilDiv(num: bigint, den: bigint): bigint {
	if (den <= 0n) throw new Error('ceilDiv: denominator must be positive');
	if (num <= 0n) return 0n;
	return (num + den - 1n) / den;
}

/**
 * Compute the Conway-era total collateral requirement from per-redeemer
 * `ex_units` budgets. Formula:
 *
 *   redeemerFee     = ceil(budget.mem * priceMem) + ceil(budget.steps * priceStep)
 *   totalScriptFee  = sum(redeemerFee across all redeemers)
 *   totalCollateral = ceil(totalScriptFee * collateralPercentage / 100)
 *
 * The result is the MINIMUM lovelace the collateral UTxO must hold. Apply a
 * safety multiplier (e.g. 1.5x) at the caller for headroom against
 * protocol-parameter changes mid-flight.
 *
 * Precision: prices arrive as decimal strings ("0.0577") or numbers. We
 * scale to bigint via `decimalToScaled` with 20 fractional digits — more
 * than enough for any realistic protocol-parameter precision (current
 * priceMem / priceStep have ≤5 fractional digits). Fractional digits beyond
 * 20 are truncated. This is a safety-margin computation, not a fee-exact
 * computation; the caller MUST add headroom on top.
 *
 * @param budgets         Per-redeemer ex_units budgets from `evaluateTx`.
 * @param protocolParams  Shape mirrors mesh's `Protocol` from
 *                        `BlockfrostProvider.fetchProtocolParameters(...)`.
 *                        `priceMem`/`priceStep` are decimals (lovelace per
 *                        unit), `collateralPercentage` is an int (e.g. 150).
 * @returns               Lovelace floor as a bigint.
 */
export function computeCollateralFromExUnits(
	budgets: Array<{ mem: number; steps: number }>,
	protocolParams: {
		priceMem: number | string;
		priceStep: number | string;
		collateralPercentage: number;
	},
): bigint {
	if (budgets.length === 0) return 0n;

	// Scale prices to bigints (×10^20) so we can multiply without floats.
	const PRICE_SCALE_DIGITS = 20;
	const priceScale = 10n ** BigInt(PRICE_SCALE_DIGITS);
	const priceMemScaled = decimalToScaled(protocolParams.priceMem, PRICE_SCALE_DIGITS);
	const priceStepScaled = decimalToScaled(protocolParams.priceStep, PRICE_SCALE_DIGITS);

	let totalScriptFee = 0n;
	for (const budget of budgets) {
		const memFee = ceilDiv(BigInt(Math.trunc(budget.mem)) * priceMemScaled, priceScale);
		const stepFee = ceilDiv(BigInt(Math.trunc(budget.steps)) * priceStepScaled, priceScale);
		totalScriptFee += memFee + stepFee;
	}

	const collateralPercentage = BigInt(Math.trunc(protocolParams.collateralPercentage));
	if (collateralPercentage <= 0n) {
		throw new Error(
			`computeCollateralFromExUnits: collateralPercentage must be positive, got ${protocolParams.collateralPercentage}`,
		);
	}

	return ceilDiv(totalScriptFee * collateralPercentage, 100n);
}

/** Why the predicate rejected a given subset of items, or `'none'` if no subset fit. */
export type BatchShrinkReason = 'window' | 'utxos' | 'collateral' | 'tx-size' | 'none';

/**
 * Outcome of a `shrinkBatchToFit` pass.
 *
 * - `fit`     — items that satisfy every batch constraint, in their original
 *               order (the caller's pre-sort by priority is preserved).
 * - `dropped` — items that were peeled off the END of the list to make the
 *               batch fit. Caller defers these to the next tick / fallback.
 * - `reason`  — `'none'` when the predicate never returned `ok: true`. When
 *               the predicate returned `ok: true` the reason is the LAST
 *               failing reason observed before the successful subset, or
 *               `'none'` when the full input fit on the first try.
 */
export type BatchShrinkResult<T> = {
	fit: T[];
	dropped: T[];
	reason: BatchShrinkReason;
};

/**
 * Iteratively drop items from the END of the batch until the remaining items
 * satisfy all batch constraints. Constraints are caller-defined via
 * `predicate` — typical predicate composition:
 *
 *   - validity-window intersection is non-empty
 *     (use `intersectTxWindows(...) != null`)
 *   - enough wallet UTxOs for the spending side after reserving collateral
 *     separately (`pickBatchCollateral(...) != null`)
 *   - tx size within `MAX_SAFE_TX_BYTES` after a build pass
 *     (use `assertTxSizeWithinLimit` wrapped in a try/catch)
 *
 * The order of `items` matters — items at the FRONT are kept first. Callers
 * MUST pre-sort by priority (e.g. oldest scheduled first, highest-fee
 * payer first) before invoking.
 *
 * Implementation: simple right-to-left shrink loop. We call
 * `predicate(items.slice(0, n))` for `n` from `items.length` down to 1; the
 * first `ok: true` wins. If the predicate is never satisfied we return
 * `{ fit: [], dropped: items, reason: 'none' }` so the caller can fall back
 * to single-item builders or surface an alert.
 *
 * @param items     Pre-sorted by priority — items at index 0 are kept first.
 * @param predicate Returns `ok: true` when the subset satisfies all
 *                  constraints. The `reason` field (when present and
 *                  `ok: false`) flows through to the result so callers can
 *                  log which constraint was the binding one.
 */
export function shrinkBatchToFit<T>(
	items: T[],
	predicate: (subset: T[]) => { ok: boolean; reason?: BatchShrinkReason },
): BatchShrinkResult<T> {
	if (items.length === 0) {
		return { fit: [], dropped: [], reason: 'none' };
	}

	let lastReason: BatchShrinkReason = 'none';
	for (let n = items.length; n >= 1; n--) {
		const subset = items.slice(0, n);
		const result = predicate(subset);
		if (result.ok) {
			return {
				fit: subset,
				dropped: items.slice(n),
				reason: n === items.length ? 'none' : lastReason,
			};
		}
		if (result.reason != null) {
			lastReason = result.reason;
		}
	}

	return { fit: [], dropped: items.slice(), reason: lastReason };
}

/**
 * Throw with a clear error if any spending input matches the collateral
 * UTxO reference.
 *
 * Conway phase-1 rejects this scenario with an opaque
 * `EvaluationFailure: ScriptFailures: {}` from ogmios which is very hard to
 * diagnose post-hoc. Failing fast off-chain with a real message is much
 * friendlier — call this just before invoking the batch builder.
 *
 * @throws Error with the offending ref if overlap is found.
 */
export function assertNoCollateralOverlap(
	collateralUtxo: { input: { txHash: string; outputIndex: number } },
	spendingUtxos: Array<{ input: { txHash: string; outputIndex: number } }>,
): void {
	const collateralKey = refKey(collateralUtxo.input);
	for (const utxo of spendingUtxos) {
		if (refKey(utxo.input) === collateralKey) {
			throw new Error(
				`Collateral UTxO overlaps with a spending input (${collateralKey}); phase-1 Conway rules forbid this`,
			);
		}
	}
}

/**
 * Conway protocol parameter `max_tx_size` is 16384 bytes. We cap at 14_000
 * to leave headroom for witness growth between build-time and sign-time —
 * adding signers, swapping a key witness for a script witness with a larger
 * Plutus program, or any post-build inflation can push a borderline-OK tx
 * over the limit at submit. 14KB is the empirical safe ceiling used across
 * the V1 builders.
 */
export const MAX_SAFE_TX_BYTES = 14_000;

/**
 * Throws if the unsigned tx (hex CBOR) exceeds `MAX_SAFE_TX_BYTES`. Useful
 * as the `predicate` body inside `shrinkBatchToFit` after a build pass:
 *
 * ```ts
 * shrinkBatchToFit(items, (subset) => {
 *   try {
 *     const tx = await buildBatch(subset);
 *     assertTxSizeWithinLimit(tx, 'batch-interaction');
 *     return { ok: true };
 *   } catch {
 *     return { ok: false, reason: 'tx-size' };
 *   }
 * });
 * ```
 *
 * The label is woven into the error message so callers can disambiguate
 * which builder produced the over-sized tx.
 *
 * @param unsignedTxHex Hex-encoded CBOR — each pair of chars is one byte.
 * @param label         Free-form label for diagnostics (e.g. 'batch-mint').
 * @throws Error when `unsignedTxHex.length / 2 > MAX_SAFE_TX_BYTES`.
 */
export function assertTxSizeWithinLimit(unsignedTxHex: string, label: string): void {
	const sizeBytes = Math.floor(unsignedTxHex.length / 2);
	if (sizeBytes > MAX_SAFE_TX_BYTES) {
		throw new Error(
			`${label}: unsigned tx size ${sizeBytes} bytes exceeds MAX_SAFE_TX_BYTES (${MAX_SAFE_TX_BYTES}); shrink the batch and retry`,
		);
	}
}
