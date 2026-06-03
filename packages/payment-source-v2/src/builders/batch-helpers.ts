// Mesh SDK pinning: this file lives in the V2 package and MUST resolve to the
// V2 mesh line (`@meshsdk/core@1.9.0-beta.102`). The helpers here are pure
// (no mesh runtime calls), but the `UTxO` shape we type against is the V2
// one — kept consistent with the rest of the V2 builders. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import type { UTxO } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';

/**
 * Lovelace amount routed into a CONDITIONAL "splitter" output that V2 batch
 * builders emit back to the funding wallet ONLY when the wallet has
 * exactly ONE fee-eligible UTxO (`walletUtxos.length === 1`, after
 * excluding the collateral input and any forced script/asset inputs).
 *
 * Per-length analysis — `walletUtxos` here is the FEE-ELIGIBLE UTxO count
 * (collateral excluded, mandatory script/asset inputs excluded):
 *
 *   - `length === 0` → tx cannot build (no fee input); splitter would not
 *     help and the build failure is the correct operational signal.
 *   - `length === 1` → mesh consumes the one fee input and emits one
 *     change. Without the splitter the wallet ends at
 *     [collateral, change] — exactly the 2-UTxO floor. Any subsequent
 *     phase-2 failure or external consolidation drops below 2 and
 *     re-triggers `ensureCollateralReady` prep. The splitter adds a 3rd
 *     UTxO so the wallet has a 1-UTxO buffer above the floor.
 *   - `length >= 2` → mesh's natural change-emission already guarantees
 *     ≥2 UTxOs post-tx (collateral untouched + change) regardless of how
 *     many fee inputs mesh consumes. The splitter would be pure
 *     over-emission AND adds an extra output that competes with the
 *     script continuation outputs for mesh's wallet selection — the
 *     symptom that surfaced as `[batch-fallback]` regressions when this
 *     threshold was previously `<= 2`.
 *
 * Mesh's default `.changeAddress(wallet)` produces ONE change output per
 * tx; the splitter is a second wallet-targeted output that, in the
 * length=1 case, raises the floor from 2 to 3.
 *
 * Sized at 5 ADA — MUST match `COLLATERAL_RESERVE_LOVELACE` in
 * `ensure-collateral-ready.ts`. When emitted, the splitter UTxO is the
 * wallet's "second UTxO reservoir" and is the obvious candidate for the
 * NEXT batch tx's collateral input (`pickBatchCollateral` prefers the
 * smallest qualifying pure-ADA UTxO with ≥ 5 ADA). Sub-5-ADA splitter
 * would force the next tx to scavenge collateral elsewhere — typically
 * promoting a larger change UTxO to collateral and burning excess lovelace
 * on `total_collateral`.
 *
 * The splitter is pure ADA so it can serve directly as the collateral input
 * for the NEXT batch tx (under Babbage, mixed UTxOs also qualify, but a
 * pure-ADA UTxO keeps `collateral_return_output` empty and minimizes
 * total_collateral computation overhead).
 *
 * Lifecycle: when emitted, the splitter output from tx N is typically
 * consumed by tx N+1 as part of mesh's coin selection (either as fee input
 * or as collateral), so the wallet does NOT permanently accrete pure-ADA
 * UTxOs across many txs — the splitter is a single-use second-UTxO
 * reservoir that fires only at the genuine trap-risk threshold.
 *
 * Cross-builder semantic invariant: every splitter call site MUST count
 * `walletUtxos` as collateral-excluded + mandatory-inputs-excluded.
 * batch-interaction.ts relies on the service-layer filter; batch-registry.ts
 * filters internally via `inputRefs.add(refKey(collateralUtxo))` before
 * deriving `walletUtxosForSelection` (see `generateRegistryBatchMintTransaction`).
 */
export const WALLET_SPLITTER_LOVELACE = 5_000_000n;

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
	} catch (parseError) {
		// A malformed `quantity` string here means blockfrost returned data that
		// violates our expectations; previously we silently treated the UTxO as
		// zero-lovelace, which made it look like an invalid collateral
		// candidate (it got skipped) without any diagnostic. Log loudly so an
		// operator can investigate; still return 0n so the helper stays total.
		logger.warn('getLovelace: malformed quantity string on UTxO; treating as 0 [batch-helpers]', {
			txHash: utxo.input.txHash,
			outputIndex: utxo.input.outputIndex,
			rawQuantity: lovelaceAsset.quantity,
			error: parseError instanceof Error ? parseError.message : parseError,
		});
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
 * Pick a collateral UTxO that is NOT also a script spending input.
 *
 * Preference order:
 *   1. Pure-ADA UTxO, smallest qualifying first — avoids burning a fat UTxO
 *      as collateral and avoids the collateral-return-output overhead that
 *      kicks in for native-token collateral.
 *   2. Native-token-carrying UTxO, smallest qualifying first — fallback when
 *      the wallet has no pure-ADA candidate (typical of selling/purchasing
 *      wallets that have accumulated NFT registration tokens). Mesh-SDK
 *      auto-emits a `collateral_return_output` in this case.
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
 * the *script* spending input set. The caller MUST pass every script input
 * ref (e.g. the per-item `smartContractUtxo.input` refs of an interaction
 * batch, or the asset UTxOs of a burn batch) via `excludeSpendingInputs`.
 * Regular wallet-input overlap is allowed — Mesh-SDK 1.9 routes
 * `.txIn(...)` and `.txInCollateral(...)` into separate body fields, so the
 * same UTxO ref can appear in both (the V1 single-tx register builder
 * already exploits this).
 *
 * Returns `null` (NOT throws) — the caller decides how to handle a missing
 * collateral (e.g. shrink the batch, fall back to single-item, surface to
 * operator).
 *
 * @param utxos                   Wallet UTxOs to choose from.
 * @param excludeSpendingInputs   Script input refs that MUST NOT also be the collateral.
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

	const pureCandidates: Array<{ utxo: UTxO; lovelace: bigint }> = [];
	const mixedCandidates: Array<{ utxo: UTxO; lovelace: bigint }> = [];
	for (const utxo of utxos) {
		if (excludeKeys.has(refKey(utxo.input))) continue;
		const lovelace = getLovelace(utxo);
		if (lovelace < requiredLovelace) continue;
		if (isPureLovelace(utxo)) {
			pureCandidates.push({ utxo, lovelace });
		} else {
			mixedCandidates.push({ utxo, lovelace });
		}
	}

	// Prefer pure-ADA; fall back to native-token UTxOs only when the wallet
	// has none. Within each group, pick the smallest qualifying UTxO so we
	// don't burn a fat one as collateral.
	const ascending = (a: { lovelace: bigint }, b: { lovelace: bigint }): number => {
		if (a.lovelace < b.lovelace) return -1;
		if (a.lovelace > b.lovelace) return 1;
		return 0;
	};
	if (pureCandidates.length > 0) {
		pureCandidates.sort(ascending);
		return pureCandidates[0].utxo;
	}
	if (mixedCandidates.length > 0) {
		mixedCandidates.sort(ascending);
		return mixedCandidates[0].utxo;
	}
	return null;
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
 * Per-spend-leg `ex_units` budgets sum across redeemers; the Conway phase-1
 * required collateral grows linearly with that sum. 3 ADA covers ~2 SPEND
 * legs at current preprod prices but is insufficient for 5+ legs, which would
 * phase-1 reject with `InsufficientCollateral`.
 *
 * We compute the floor from the actual evaluated budgets via
 * `computeCollateralFromExUnits`, then apply this safety multiplier as
 * headroom against protocol-parameter changes mid-flight (priceMem/priceStep
 * rarely change but `collateralPercentage` has shifted historically).
 *
 * Expressed as bigint numerator/denominator to keep the math integer-only.
 */
export const COLLATERAL_SAFETY_NUM = 150n;
export const COLLATERAL_SAFETY_DEN = 100n;

/**
 * Floor — even a single-leg tx with tiny budgets must hold this much in
 * collateral. Matches the V1 single-item builder default and prevents the
 * derived value from rounding down below mesh's minimum-collateral check.
 */
export const MIN_TOTAL_COLLATERAL_LOVELACE = 3_000_000n;

/**
 * Shape we accept from any of mesh's `Protocol`, the V1 helper's cached
 * `Protocol`-like object, or a raw blockfrost protocol-params response.
 * Fields are optional because the loose `unknown` input we receive may carry
 * either camelCase (`priceMem`) or snake_case (`price_mem`) keys, and either
 * `collateralPercent` (mesh) or `collateralPercentage` (our helper's name)
 * or `collateral_percent` (blockfrost raw).
 */
type ProtocolParamCandidate = {
	priceMem?: number | string;
	price_mem?: number | string;
	priceStep?: number | string;
	price_step?: number | string;
	collateralPercentage?: number;
	collateralPercent?: number;
	collateral_percent?: number;
};

/**
 * Narrow the loosely-typed protocol-parameters bag (mesh's `Protocol` ∪ the
 * shared cache's `unknown`) into the exact shape `computeCollateralFromExUnits`
 * expects. Mesh's V2 `Protocol` type names the field `collateralPercent` while
 * our helper uses `collateralPercentage`; bridge that here. Returns `null` if
 * any required field is missing — the caller falls back to the static
 * `MIN_TOTAL_COLLATERAL_LOVELACE` in that case rather than crashing.
 */
export function extractCollateralProtocolParams(
	protocolParameters: unknown,
): { priceMem: number | string; priceStep: number | string; collateralPercentage: number } | null {
	if (protocolParameters == null || typeof protocolParameters !== 'object') return null;
	const p = protocolParameters as ProtocolParamCandidate;
	const priceMem = p.priceMem ?? p.price_mem;
	const priceStep = p.priceStep ?? p.price_step;
	const collateralPercentage = p.collateralPercentage ?? p.collateralPercent ?? p.collateral_percent;
	if (priceMem == null || priceStep == null || collateralPercentage == null) return null;
	if (typeof priceMem !== 'number' && typeof priceMem !== 'string') return null;
	if (typeof priceStep !== 'number' && typeof priceStep !== 'string') return null;
	if (typeof collateralPercentage !== 'number') return null;
	return { priceMem, priceStep, collateralPercentage };
}

/**
 * Derive Conway phase-1 total collateral from per-redeemer exUnits budgets.
 *
 * Sums the budgets, runs `computeCollateralFromExUnits`, applies the safety
 * multiplier, and floors at `MIN_TOTAL_COLLATERAL_LOVELACE`. Returned as a
 * string in the shape `setTotalCollateral(...)` expects.
 */
export function deriveTotalCollateral(
	budgets: Array<{ mem: number; steps: number }>,
	protocolParameters: unknown,
): string {
	const params = extractCollateralProtocolParams(protocolParameters);
	if (params == null) {
		return MIN_TOTAL_COLLATERAL_LOVELACE.toString();
	}
	const raw = computeCollateralFromExUnits(budgets, params);
	const withSafety = (raw * COLLATERAL_SAFETY_NUM) / COLLATERAL_SAFETY_DEN;
	const floored = withSafety > MIN_TOTAL_COLLATERAL_LOVELACE ? withSafety : MIN_TOTAL_COLLATERAL_LOVELACE;
	return floored.toString();
}

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
