/**
 * Conway phase-1 collateral math, shared by every builder that declares
 * `total_collateral`.
 *
 * Mesh SDK pinning (ADR 0005): this module touches NO mesh runtime and does
 * not even import a mesh type. `CollateralUtxoLike` is a structural shape that
 * both pinned `UTxO` types satisfy, so V1 (`src/`, mesh beta.96) and V2
 * (`packages/payment-source-v2`, mesh beta.102) can share one implementation
 * with no risk of collapsing the two mesh lines onto each other. Keep it that
 * way: if this file ever needs a mesh value import, split it per rail instead.
 *
 * Why this is shared rather than a per-builder constant: the declared total is
 * pinned between two moving bounds. It must sit ABOVE the ledger's requirement
 * (`collateralPercentage` of the fee, else `InsufficientCollateral`) and
 * strictly BELOW what the collateral input holds, because mesh always emits a
 * `collateral_return` of `input - declared` and never min-UTxO-checks it. A
 * hardcoded constant cannot track either bound.
 */

/**
 * Structural shape of the parts of a mesh `UTxO` this module reads.
 *
 * Declared locally rather than imported so payment-core stays free of a mesh
 * dependency. Both pinned `UTxO` types are assignable to it.
 */
export type CollateralUtxoLike = {
	output: { amount: Array<{ unit: string; quantity: string }> };
};

/**
 * Internal: parse a decimal value (number or string) into a scaled bigint.
 * Returns `value * 10^scaleDigits` rounded toward zero. Designed for
 * Cardano protocol-parameter decimals like price_mem = "0.0577" which are
 * exact rationals on-chain but arrive at us as decimal strings.
 *
 * Precision: we pad to 20 fractional digits which is well beyond any
 * realistic protocol-parameter precision. Any fractional digits beyond 20
 * are truncated (NOT rounded), acceptable for a safety-margin computation,
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
 * safety multiplier (e.g. 1.5x) at the caller for headroom.
 *
 * KNOWN UNDERCOUNT: the ledger takes `collateralPercentage` of the WHOLE fee,
 * and the whole fee is the script fee plus the size fee
 * (`txFeePerByte * size + txFeeFixed`). This reads the script half only. The
 * size half is bounded by `maxTxSize` (16 KB), so it contributes at most
 * ~876k lovelace, and `COLLATERAL_SAFETY_NUM` plus
 * `MIN_TOTAL_COLLATERAL_LOVELACE` absorb it at every budget these builders
 * produce. Do not treat this as fee-exact.
 *
 * Precision: prices arrive as decimal strings ("0.0577") or numbers. We
 * scale to bigint via `decimalToScaled` with 20 fractional digits, more
 * than enough for any realistic protocol-parameter precision (current
 * priceMem / priceStep have <=5 fractional digits). Fractional digits beyond
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

	// Scale prices to bigints (x10^20) so we can multiply without floats.
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
 * Floor: even a single-leg tx with tiny budgets must hold this much in
 * collateral. Matches the V1 single-item builder default and prevents the
 * derived value from rounding down below mesh's minimum-collateral check.
 */
export const MIN_TOTAL_COLLATERAL_LOVELACE = 3_000_000n;

/**
 * Min-ADA headroom kept aside on the collateral input when clamping declared
 * total collateral, so the resulting collateral-return output still satisfies
 * the ledger's min-UTxO rule. 1 ADA comfortably exceeds the min-ADA of a
 * PURE-ADA output at current `coinsPerUtxoSize`.
 */
export const COLLATERAL_RETURN_MIN_LOVELACE = 1_000_000n;

/**
 * Extra min-ADA headroom per distinct native asset carried by the collateral.
 *
 * Mesh's collateral return carries the FULL value of the collateral input,
 * tokens included (verified against both pinned mesh lines: `addCollateralReturn`
 * merges `toValue(collateral.txIn.amount)` into the return). Each distinct
 * asset therefore grows the return output, and the ledger's
 * `(160 + outputSize) * coinsPerUtxoByte` floor grows with it, while Mesh
 * never min-ADA-checks the collateral return itself (`sanitizeOutputs` only
 * walks `meshTxBuilderBody.outputs`).
 *
 * A flat 1 ADA floor is therefore only correct for pure-ADA collateral. Sized
 * generously: ~50 bytes per asset at `coinsPerUtxoSize` 4310 is ~215k lovelace,
 * so 350k leaves margin without meaningfully reducing declarable collateral.
 */
export const COLLATERAL_RETURN_MIN_LOVELACE_PER_ASSET = 350_000n;

/** Distinct native (non-lovelace) assets carried by a UTxO. */
export function nativeAssetCount(utxo: CollateralUtxoLike): number {
	return utxo.output.amount.filter((asset) => asset.unit !== 'lovelace' && asset.unit !== '').length;
}

/**
 * Min-ADA to reserve for the collateral-return output, given how many native
 * assets the collateral input carries. Pure-ADA collateral keeps the original
 * 1 ADA floor.
 */
export function collateralReturnMinLovelace(assetCount: number): bigint {
	if (assetCount <= 0) return COLLATERAL_RETURN_MIN_LOVELACE;
	return COLLATERAL_RETURN_MIN_LOVELACE + BigInt(assetCount) * COLLATERAL_RETURN_MIN_LOVELACE_PER_ASSET;
}

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
 * Narrow the loosely-typed protocol-parameters bag (mesh's `Protocol` union the
 * shared cache's `unknown`) into the exact shape `computeCollateralFromExUnits`
 * expects. Mesh's V2 `Protocol` type names the field `collateralPercent` while
 * our helper uses `collateralPercentage`; bridge that here. Returns `null` if
 * any required field is missing: the caller falls back to the static
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
	collateralCapLovelace?: bigint,
	collateralNativeAssetCount: number = 0,
): string {
	const params = extractCollateralProtocolParams(protocolParameters);
	if (params == null) {
		return MIN_TOTAL_COLLATERAL_LOVELACE.toString();
	}
	const raw = computeCollateralFromExUnits(budgets, params);
	const withSafety = (raw * COLLATERAL_SAFETY_NUM) / COLLATERAL_SAFETY_DEN;
	let total = withSafety > MIN_TOTAL_COLLATERAL_LOVELACE ? withSafety : MIN_TOTAL_COLLATERAL_LOVELACE;
	// Never declare more collateral than the single collateral input can cover.
	// The first build pass uses inflated DEFAULT_EX_UNITS budgets, so the derived
	// requirement can exceed the (typically 5 ADA) collateral UTxO; mesh then
	// computes collateralInput - totalCollateral < 0, emits a negative
	// collateral-return output, and throws at build time, silently forcing
	// single-item fallback for any batch of ~4+ legs. Cap to the input value
	// (leaving a min-ADA collateral-return) so the evaluation build succeeds; the
	// second pass uses real, far smaller budgets that stay well under the cap.
	// The reserved headroom scales with the collateral's native assets: mesh
	// copies them into the collateral return, so a token-bearing return needs
	// more min-ADA than a pure-ADA one.
	const returnMinLovelace = collateralReturnMinLovelace(collateralNativeAssetCount);
	if (collateralCapLovelace != null && collateralCapLovelace > returnMinLovelace) {
		const cap = collateralCapLovelace - returnMinLovelace;
		if (cap >= MIN_TOTAL_COLLATERAL_LOVELACE && total > cap) {
			total = cap;
		}
	}
	return total.toString();
}
