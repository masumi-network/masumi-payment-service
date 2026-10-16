// Mesh SDK pinning: this file lives in the V2 package and MUST resolve to the
// V2 mesh line (`@meshsdk/core@1.9.0-beta.102`). The helpers here are pure
// (no mesh runtime calls), but the `UTxO` shape we type against is the V2
// one — kept consistent with the rest of the V2 builders. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import type { UTxO } from '@meshsdk/core';
// Shared with the V1 rail on purpose. Unlike `getSpendableWalletUtxos` below
// — duplicated to keep the mesh lines isolated — the collateral RANKING must
// be identical on both rails, and `@/utils/utxo` carries no mesh runtime
// (it imports `UTxO` as a type only), so importing it cannot collapse this
// package onto the V1 mesh line. See the note at the top of that file.
import { pickCollateralUtxo } from '@/utils/utxo';

/**
 * Lovelace amount routed into a CONDITIONAL "splitter" output that V2 batch
 * builders emit back to the funding wallet ONLY when the wallet has
 * exactly ONE non-collateral wallet UTxO after excluding forced script/asset
 * inputs. The collateral is held back from Mesh's regular-input candidate
 * list (see getSpendableWalletUtxos) and is excluded here too when deciding
 * whether the optional splitter is useful.
 *
 * Per-length analysis — this is the non-collateral wallet UTxO count:
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
 * Splitter decisions count the collateral separately from ordinary wallet
 * candidates, and so does coin selection: the builders hand Mesh the
 * collateral-free candidate list first, offering the reserve only if the tx
 * cannot otherwise balance (buildWithCollateralFallback).
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

/** Canonical reference string for a UTxO — must match the format the builders use. */
function refKey(input: { txHash: string; outputIndex: number }): string {
	return `${input.txHash}#${input.outputIndex}`;
}

/**
 * Keeps every payment-key wallet candidate available to Mesh while excluding
 * only inputs that the transaction already spends as scripts.
 *
 * This does NOT exclude the declared collateral — see
 * `getSpendableWalletUtxos`, which the builders apply immediately before
 * handing the candidates to `selectUtxosFrom`.
 */
export function getWalletUtxosForSelection(
	utxos: UTxO[],
	scriptSpendingInputs: Array<{ txHash: string; outputIndex: number }>,
): UTxO[] {
	const scriptInputKeys = new Set(scriptSpendingInputs.map(refKey));
	return utxos.filter((utxo) => !scriptInputKeys.has(refKey(utxo.input)));
}

/**
 * Returns the wallet UTxOs Mesh may consume as regular inputs.
 *
 * CIP-40 permits a VKey UTxO in both the regular and collateral input sets,
 * and Mesh leans on that: `selectUtxosFrom` does NOT exclude UTxOs declared
 * via `.txInCollateral(...)` — `getUtxosForSelection` only skips UTxOs
 * already present in `meshTxBuilderBody.inputs`, never `collaterals`.
 *
 * Ledger-valid is not the same as operationally safe. Left unfiltered, coin
 * selection spends the collateral reserve as a regular input (118 of 153
 * sampled builds against the V1-pinned mesh line, which shares this
 * selection code). The transaction confirms, but the wallet is left with no
 * dedicated collateral and the NEXT escrow action fails to find one.
 *
 * The collateral is handed back to coin selection only when excluding it
 * would leave nothing to balance with.
 *
 * Mirrors `getSpendableWalletUtxos` in `src/utils/utxo` — deliberately
 * duplicated rather than shared, to keep the V1 and V2 mesh lines isolated
 * per ADR 0005.
 */
export function getSpendableWalletUtxos(walletUtxos: UTxO[], collateralUtxo: UTxO): UTxO[] {
	const collateralKey = refKey(collateralUtxo.input);
	const spendableUtxos = walletUtxos.filter((utxo) => refKey(utxo.input) !== collateralKey);
	return spendableUtxos.length > 0 ? spendableUtxos : walletUtxos;
}

/**
 * Pick a collateral UTxO that is NOT also a script spending input.
 *
 * Ordering is defined once, in `rankCollateralCandidates` (`@/utils/utxo`),
 * and shared by every rail and action: pure-ADA first, then smallest
 * qualifying lovelace, then `txHash#index` as a deterministic tie-break.
 *
 * A native-token-carrying UTxO is a perfectly valid collateral, not a
 * degraded fallback: Babbage/CIP-40 permits it and the builder's
 * `setTotalCollateral` declaration makes Mesh emit the `collateral_return`
 * output that carries the balance back. Pure ADA is merely preferred because
 * it keeps that return output smaller.
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
 * Collateral must be payment-key-locked, so script-locked spending inputs can
 * never serve as collateral. The caller MUST pass every script input ref
 * (e.g. the per-item `smartContractUtxo.input` refs of an interaction batch)
 * via `excludeSpendingInputs`. Some registry burn/update callers also pass
 * forced asset inputs to preserve the current separate-collateral builder
 * policy. Regular VKey wallet-input overlap is allowed by the ledger —
 * Mesh-SDK 1.9 routes `.txIn(...)` and `.txInCollateral(...)` into separate
 * body fields, so the same UTxO ref can appear in both (the V1 single-tx
 * register builder already exploits this).
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
	// Delegates to the shared selector so the batch builders, the single-action
	// builders and the registry paths all rank collateral identically. The
	// previous local copy differed subtly (no deterministic tie-break), which
	// let two equal-sized UTxOs swap places between builds.
	return pickCollateralUtxo(utxos, requiredLovelace, excludeSpendingInputs);
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
 * For script inputs, the ledger reason is that collateral must be
 * payment-key-locked. For other forced inputs, this is the current builder's
 * separate-collateral policy. Failing fast off-chain with a real message is
 * much friendlier than letting a later builder/submission error obscure the
 * offending ref.
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
				`Collateral UTxO overlaps with a spending input (${collateralKey}); current builder requires a separate collateral ref`,
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

// Conway phase-1 collateral math moved to `@masumi/payment-core/collateral` so
// the V1-pinned registry builders in `src/services/registry/shared.ts` can
// share one implementation with the V2 batch builders (ADR 0005: the module
// imports no mesh symbol, so neither mesh line can collapse onto the other).
// Re-exported here because every batch call site imports it from this file.
export {
	COLLATERAL_RETURN_MIN_LOVELACE,
	COLLATERAL_RETURN_MIN_LOVELACE_PER_ASSET,
	COLLATERAL_SAFETY_DEN,
	COLLATERAL_SAFETY_NUM,
	MIN_TOTAL_COLLATERAL_LOVELACE,
	collateralReturnMinLovelace,
	computeCollateralFromExUnits,
	deriveTotalCollateral,
	extractCollateralProtocolParams,
	nativeAssetCount,
} from '@masumi/payment-core/collateral';

/**
 * Lovelace quantity held by a UTxO (0 if it somehow carries no ADA entry).
 * Used to cap declared collateral to what the collateral input can actually
 * cover.
 */
export function lovelaceFromUtxo(utxo: UTxO): bigint {
	const entry = utxo.output.amount.find((asset) => asset.unit === 'lovelace' || asset.unit === '');
	return entry != null ? BigInt(entry.quantity) : 0n;
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

/**
 * Non-throwing companion to `assertTxSizeWithinLimit`. Returns `true` when the
 * unsigned tx (hex CBOR) is within `MAX_SAFE_TX_BYTES`. Use this to drive an
 * async size-aware shrink loop where the builder is async and therefore cannot
 * run inside the synchronous `shrinkBatchToFit` predicate.
 *
 * @param unsignedTxHex Hex-encoded CBOR — each pair of chars is one byte.
 */
export function isTxSizeWithinLimit(unsignedTxHex: string): boolean {
	return Math.floor(unsignedTxHex.length / 2) <= MAX_SAFE_TX_BYTES;
}
