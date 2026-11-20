// Mesh SDK pinning (ADR 0005): this module lives in shared `src/`, which is
// implicitly V1-pinned, yet the V2 builders consume it too. That is safe ONLY
// because nothing here touches the mesh RUNTIME — `UTxO` is imported as a
// TYPE, so the compiled output carries no `@meshsdk/core` import at all and
// pkgroll cannot collapse the V2 bundle onto the V1 mesh line. Keep it that
// way: if this file ever needs a mesh VALUE import, the collateral helpers
// must be duplicated per rail instead (the precedent is
// `getSpendableWalletUtxos`, which is duplicated in the V2 batch-helpers).
import type { UTxO } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';

const DEFAULT_MIN_COLLATERAL_LOVELACE = 5_000_000n;

/**
 * Reads the lovelace quantity off a UTxO as `bigint`.
 *
 * Cardano lovelace quantities can exceed `Number.MAX_SAFE_INTEGER`
 * (2^53 - 1 ≈ 9.0e15). Mainnet has individual whale UTxOs above this
 * boundary, and the protocol-allowed maximum (~45e15 lovelace = 45M ADA
 * per UTxO with the current supply) cannot fit in a JS Number without
 * truncation. Project rule (CLAUDE.md): use BigInt for all monetary
 * amounts; never use Number for lovelace values.
 */
export function getLovelaceFromUtxo(utxo: UTxO): bigint {
	const lovelaceAsset = utxo.output.amount.find((asset) => asset.unit === 'lovelace' || asset.unit === '');
	if (lovelaceAsset == null) return 0n;
	try {
		return BigInt(lovelaceAsset.quantity);
	} catch (parseError) {
		// A malformed `quantity` means the provider returned data that violates
		// our expectations. Stay total and return 0n (the UTxO simply drops out
		// of collateral/selection candidacy) but log loudly so an operator can
		// investigate — a bare `BigInt(...)` here would instead throw and abort
		// the whole batch tick. Behaviour lifted from the V2 batch-helpers copy
		// so both rails share it.
		logger.warn('getLovelaceFromUtxo: malformed quantity string on UTxO; treating as 0', {
			txHash: utxo.input.txHash,
			outputIndex: utxo.input.outputIndex,
			rawQuantity: lovelaceAsset.quantity,
			error: parseError instanceof Error ? parseError.message : parseError,
		});
		return 0n;
	}
}

function isSameUtxo(left: UTxO, right: UTxO): boolean {
	return left.input.txHash === right.input.txHash && left.input.outputIndex === right.input.outputIndex;
}

/**
 * Returns the wallet UTxOs Mesh may consume as regular inputs.
 *
 * Mesh's `selectUtxosFrom` does NOT exclude UTxOs declared via
 * `.txInCollateral(...)`: `getUtxosForSelection` only skips UTxOs already
 * present in `meshTxBuilderBody.inputs`, never the ones in `collaterals`.
 * Left unfiltered, coin selection routinely spends the collateral UTxO as a
 * regular input (118 of 153 sampled builds), so the tx confirms but the
 * wallet is left with no dedicated collateral reserve and the NEXT escrow
 * action fails in `selectCollateralUtxo`.
 *
 * The collateral is only handed back to coin selection when excluding it
 * would leave nothing to balance with — a tx that cannot be funded is worse
 * than one that consumes the reserve.
 *
 * Pure-ADA UTxOs are offered first (see `preferAdaOnlyUtxos`): a fee input
 * must not drag the agent NFT or other tokens into the change output. The
 * callers' collateral fallback re-offers the whole wallet when ADA-only
 * cannot balance the tx.
 */
export function getSpendableWalletUtxos(walletUtxos: UTxO[], collateralUtxo: UTxO): UTxO[] {
	const spendableUtxos = walletUtxos.filter((utxo) => !isSameUtxo(utxo, collateralUtxo));
	return spendableUtxos.length > 0 ? preferAdaOnlyUtxos(spendableUtxos) : walletUtxos;
}

/**
 * Coin-selection candidates for FEE inputs: the pure-ADA UTxOs when there are
 * any, otherwise the list unchanged.
 *
 * Mesh's `selectUtxosFrom` may pick any candidate, and every token on a picked
 * UTxO lands in the change output. That silently moves the agent registry NFT
 * or a stablecoin balance as a side effect of paying a fee, and a guarded
 * co-signer refuses the resulting change (`asset_not_listed`). Callers that
 * offer this subset must fall back to the full wallet when it cannot balance
 * the tx — see `buildPreferringAdaOnlyInputs`.
 */
export function preferAdaOnlyUtxos(utxos: UTxO[]): UTxO[] {
	const adaOnlyUtxos = utxos.filter(isPureAdaUtxo);
	// Same reference back when there is nothing to prefer, so callers can tell.
	return adaOnlyUtxos.length === 0 || adaOnlyUtxos.length === utxos.length ? utxos : adaOnlyUtxos;
}

/**
 * Runs `build` with the wallet's pure-ADA UTxOs only, and re-runs it with the
 * whole wallet if that attempt fails (today's behaviour). Any error triggers
 * the retry on purpose: "ADA-only cannot cover it" surfaces as several Mesh
 * messages or as an empty pool, and a genuine failure just fails again, with
 * its own error, on the second attempt.
 *
 * For builders that have no collateral fallback of their own; the interaction
 * builders get the same preference through `getSpendableWalletUtxos`.
 */
export async function buildPreferringAdaOnlyInputs<T>(
	walletUtxos: UTxO[],
	build: (candidateUtxos: UTxO[]) => Promise<T>,
): Promise<T> {
	const candidateUtxos = preferAdaOnlyUtxos(walletUtxos);
	if (candidateUtxos === walletUtxos) {
		return await build(walletUtxos);
	}
	try {
		return await build(candidateUtxos);
	} catch (error) {
		logger.warn('Tx could not be built from ADA-only wallet UTxOs; retrying with token-carrying UTxOs offered too', {
			error: error instanceof Error ? error.message : String(error),
		});
		return await build(walletUtxos);
	}
}

/** Stable `txHash#index` key for a UTxO reference. */
export function utxoRefKey(ref: { txHash: string; outputIndex: number }): string {
	return `${ref.txHash}#${ref.outputIndex}`;
}

/** Whether a UTxO carries lovelace only (no native tokens). */
export function isPureAdaUtxo(utxo: UTxO): boolean {
	return utxo.output.amount.every((asset) => asset.unit === 'lovelace' || asset.unit === '');
}

/**
 * Ranks the wallet's UTxOs by their suitability as a collateral input, best
 * first. Every qualifying UTxO is returned, so callers that need a second
 * choice (e.g. when the best one is already a spending input) can walk the
 * list instead of re-implementing the ordering.
 *
 * ORDERING — the single definition used by every rail and every action:
 *
 *  1. Pure-ADA before mixed. Multi-asset collateral is perfectly valid:
 *     Babbage/CIP-40 permits it, and the builder declares `setTotalCollateral`
 *     so a `collateral_return` output carries the balance (including the
 *     native tokens) back to the wallet. Pure ADA is preferred only because it
 *     keeps that return output smaller and the fee marginally lower — a
 *     token-bearing UTxO is a fine collateral, never an error.
 *  2. Smallest qualifying lovelace first, so a fat UTxO is not tied up as
 *     collateral when a modest one would do.
 *  3. `txHash#index` as the final tie-break. This is what makes selection
 *     DETERMINISTIC: two UTxOs of equal size must not swap places between
 *     builds, because registry paths derive the minted asset name from the
 *     chosen input and a reordering there would change the asset name.
 */
export function rankCollateralCandidates(
	utxos: UTxO[],
	minimumLovelace: bigint = DEFAULT_MIN_COLLATERAL_LOVELACE,
	excludeRefs: Array<{ txHash: string; outputIndex: number }> = [],
): UTxO[] {
	const excluded = new Set(excludeRefs.map(utxoRefKey));

	return utxos
		.filter(
			(utxo) =>
				utxo.output.amount.length > 0 &&
				!excluded.has(utxoRefKey(utxo.input)) &&
				getLovelaceFromUtxo(utxo) >= minimumLovelace,
		)
		.map((utxo) => ({ utxo, isPureAda: isPureAdaUtxo(utxo), lovelace: getLovelaceFromUtxo(utxo) }))
		.sort((left, right) => {
			if (left.isPureAda !== right.isPureAda) {
				return left.isPureAda ? -1 : 1;
			}
			if (left.lovelace < right.lovelace) return -1;
			if (left.lovelace > right.lovelace) return 1;
			return utxoRefKey(left.utxo.input).localeCompare(utxoRefKey(right.utxo.input));
		})
		.map((entry) => entry.utxo);
}

/**
 * Selects a collateral input, or null when the wallet has none big enough.
 *
 * See `rankCollateralCandidates` for the ordering. Returns null rather than
 * throwing so batch callers can defer to the next tick; `selectCollateralUtxo`
 * is the throwing variant for single-action paths that cannot defer.
 */
export function pickCollateralUtxo(
	utxos: UTxO[],
	minimumLovelace: bigint = DEFAULT_MIN_COLLATERAL_LOVELACE,
	excludeRefs: Array<{ txHash: string; outputIndex: number }> = [],
): UTxO | null {
	return rankCollateralCandidates(utxos, minimumLovelace, excludeRefs)[0] ?? null;
}

/**
 * Selects a collateral input, throwing when none qualifies.
 *
 * Same ordering as `pickCollateralUtxo` — this wrapper exists for the paths
 * that treat "no collateral" as an immediate failure rather than a deferral.
 */
export function selectCollateralUtxo(
	utxos: UTxO[],
	minimumLovelace: bigint = DEFAULT_MIN_COLLATERAL_LOVELACE,
	excludeRefs: Array<{ txHash: string; outputIndex: number }> = [],
): UTxO {
	const collateralUtxo = pickCollateralUtxo(utxos, minimumLovelace, excludeRefs);

	if (collateralUtxo == null) {
		throw new Error(`Collateral UTxO not found with at least ${minimumLovelace.toString()} lovelace`);
	}

	return collateralUtxo;
}

/**
 * Sorts UTXOs by lovelace amount in descending order (O(n log n)), pure-ADA
 * UTxOs ahead of token-carrying ones.
 *
 * Registry paths take `[0]` as the forced tx input; leading with a pure-ADA
 * UTxO keeps the agent NFT / other tokens from being moved as a side effect.
 * A token-carrying UTxO still leads when the wallet has no pure-ADA one.
 *
 * Uses BigInt comparisons throughout — see `getLovelaceFromUtxo`. The
 * comparator cannot return `bigint`, so it converts the sign of the
 * BigInt diff to `-1 / 0 / 1`.
 */
export function sortUtxosByLovelaceDesc(utxos: UTxO[]): UTxO[] {
	const utxosWithLovelace = utxos.map((utxo) => ({
		utxo,
		isPureAda: isPureAdaUtxo(utxo),
		lovelace: getLovelaceFromUtxo(utxo),
	}));

	return utxosWithLovelace
		.sort((a, b) => {
			if (a.isPureAda !== b.isPureAda) return a.isPureAda ? -1 : 1;
			if (b.lovelace > a.lovelace) return 1;
			if (b.lovelace < a.lovelace) return -1;
			// Deterministic tie-break. Registry paths take `[0]` as the tx's
			// `firstUtxo` and derive the MINTED ASSET NAME from it, so two
			// equal-lovelace UTxOs must not swap places between builds. Array
			// sort is stable, but the provider's UTxO order is not guaranteed
			// stable across calls, so equal sizes previously left the asset name
			// dependent on whatever order Blockfrost happened to return.
			return utxoRefKey(a.utxo.input).localeCompare(utxoRefKey(b.utxo.input));
		})
		.map((item) => item.utxo);
}

function sortUtxosByBloatAsc(utxos: UTxO[]): UTxO[] {
	// `.slice()` first so the in-place `.sort()` doesn't mutate the caller's
	// array. `sortUtxosByLovelaceDesc` above already produces a fresh array via
	// `.map(...).sort()`; mirror that immutability guarantee here.
	return utxos.slice().sort((a, b) => {
		const byBloat = a.output.amount.length - b.output.amount.length;
		if (byBloat !== 0) return byBloat;
		// Same deterministic tie-break as `sortUtxosByLovelaceDesc`: callers take
		// `[0]` off this list as the collateral, and equal-bloat UTxOs must not
		// reorder between builds.
		return utxoRefKey(a.input).localeCompare(utxoRefKey(b.input));
	});
}

/**
 * Picks wallet UTxOs to cover `requiredLovelace` for tx fees and outputs.
 *
 * Earlier this function required every candidate UTxO to be >= 5 ADA on its
 * own, which made sense for the V1 single-item flow where a freshly-funded
 * buyer wallet always had at least one large change UTxO. The V2 batch flow
 * spends most of the wallet in one go (N script outputs in a single
 * batch-payments tx), so by the time the buyer-side actions run the wallet
 * typically has only sub-5-ADA change UTxOs. The hard 5 ADA per-UTxO filter
 * then returned an empty set even when the wallet's total balance comfortably
 * exceeded `requiredLovelace`, and the throw bubbled all the way up out of
 * `processWalletBatch` — silently aborting every batch tick until the test
 * timed out.
 *
 * Fix: drop the 5 ADA per-UTxO filter and let the accumulator pick whichever
 * UTxOs cover the requirement. Only completely empty inputs are skipped (the
 * `lovelace > 0` guard). Mesh's coin-selection downstream rebuilds inputs
 * anyway, so emitting extra small UTxOs here doesn't expand the tx body.
 */
function limitUtxos(utxos: UTxO[], requiredLovelace: number): UTxO[] {
	const nonEmpty = utxos.filter((utxo) => getLovelaceFromUtxo(utxo) > 0n);
	if (nonEmpty.length === 0) {
		throw new Error('No suitable UTXOs found');
	}
	const selectedUtxos: UTxO[] = [];
	let accumulatedLovelace = 0n;
	// requiredLovelace stays `number` for caller ergonomics — callers pass
	// small literals like 8_000_000 (8 ADA). BigInt comparisons require both
	// sides to be bigint, so coerce once up front. requiredLovelace is well
	// inside safe range so no precision loss.
	const requiredLovelaceBig = BigInt(requiredLovelace);
	for (const utxo of nonEmpty) {
		if (accumulatedLovelace > requiredLovelaceBig) {
			break;
		}
		accumulatedLovelace += getLovelaceFromUtxo(utxo);
		selectedUtxos.push(utxo);
	}
	return selectedUtxos;
}

/**
 * Combined function: sort and limit UTXOs in one operation
 */
export function sortAndLimitUtxos(utxos: UTxO[], requiredLovelace: number): UTxO[] {
	const sortedUtxos = sortUtxosByBloatAsc(utxos);

	const limitedUtxos = limitUtxos(sortedUtxos, requiredLovelace);
	if (limitedUtxos.length === 0) {
		throw new Error('No suitable UTXOs found');
	}
	return limitedUtxos;
}
