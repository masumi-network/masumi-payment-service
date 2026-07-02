// Mesh SDK pinning: this file lives in the V2 package and MUST resolve to the
// V2 mesh line (`@meshsdk/core@1.9.0-beta.102` / `@meshsdk/core-cst@1.9.0-beta.102`).
// The derived script-data-hash and CBOR encoding depend on the exact serializer
// behavior of these versions. Do not unify with the V1 pin. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import {
	type Asset,
	type BlockfrostProvider,
	type Data,
	type IFetcher,
	type LanguageVersion,
	MeshTxBuilder,
	mOutputReference,
	type Network,
	type UTxO,
} from '@meshsdk/core';
import { assertDistinctReferenceSignatures } from './assert-distinct-reference-signatures';
import { resolvePlutusScriptAddress } from '@meshsdk/core-cst';
import { convertNetworkToId } from '@masumi/payment-core';
import type { Network as PrismaNetwork } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';
import { calculateMinUtxo, calculateTopUpAmount, getLovelaceFromAmounts, getNativeTokenCount } from '@/utils/min-utxo';
import { getCachedChainProtocolParameters } from '@/utils/mesh-cost-model-sync';
import { syncMeshCostModelsFromChainV2 } from '../utils/mesh-cost-model-sync';
import { deriveTotalCollateral, lovelaceFromUtxo, WALLET_SPLITTER_LOVELACE } from './batch-helpers';
import { generateRedeemerData } from './redeemer-data';

// Mirrors `FALLBACK_COINS_PER_UTXO_SIZE` in @masumi/payment-core/config.
// Kept inline (rather than imported) because this module is re-exported from
// the V2 package root, and some specs mock `@masumi/payment-core/config` with
// a partial surface — importing `CONSTANTS` here would fail those mocks at
// ESM link time even though the test code never executes this builder.
// Update both in lockstep if upstream changes the fallback value.
const FALLBACK_COINS_PER_UTXO_SIZE = 4310;

export type V2InteractionType = 'AuthorizeRefund' | 'AuthorizeWithdrawal' | 'RequestRefund' | 'SubmitResult';

/**
 * One spend leg of a V2 batch-interaction transaction. The batch builder packs
 * multiple `BatchInteractionItem`s of the SAME `type` into a single tx and
 * emits a per-input `Spend` redeemer and a per-input continuation output. The
 * Aiken validator runs once per input — each invocation sees only its own
 * `own_ref` and its own continuation datum.
 */
export type BatchInteractionItem = {
	type: V2InteractionType;
	smartContractUtxo: UTxO;
	newInlineDatum: Data;
	/** Optional override; defaults to `getNativeTokenCount(smartContractUtxo.output.amount)`. */
	nativeTokenCount?: number;
};

function convertMeshNetworkToPrismaNetwork(network: Network): PrismaNetwork {
	switch (network) {
		case 'mainnet':
			return 'Mainnet';
		case 'preprod':
			return 'Preprod';
		default:
			throw new Error(`Unsupported network: ${network}`);
	}
}

/**
 * Stable lex order on `(txHash, outputIndex)`. Cardano canonically sorts ALL
 * tx body inputs (script + wallet) by `(txHash, outputIndex)` before assigning
 * redeemer pointer indices. By pre-sorting our items with the same key, the
 * I-th canonically-sorted script input in the body is sortedItems[I] — and
 * that one-to-one position-vs-index mapping is what `buildSpendBudgetMap`
 * relies on to remap the body-canonical `action.index` values evaluateTx
 * returns back to our local per-item array index.
 */
function compareUtxoRef(a: UTxO, b: UTxO): number {
	if (a.input.txHash < b.input.txHash) return -1;
	if (a.input.txHash > b.input.txHash) return 1;
	return a.input.outputIndex - b.input.outputIndex;
}

function sortItemsCanonical<T extends { smartContractUtxo: UTxO }>(items: T[]): T[] {
	return [...items].sort((a, b) => compareUtxoRef(a.smartContractUtxo, b.smartContractUtxo));
}

function refKey(utxo: UTxO): string {
	return `${utxo.input.txHash}#${utxo.input.outputIndex}`;
}

function assertDistinctRefs<T extends { smartContractUtxo: UTxO }>(items: T[]): void {
	const seen = new Set<string>();
	for (const item of items) {
		const key = refKey(item.smartContractUtxo);
		if (seen.has(key)) {
			throw new Error(`Duplicate smartContractUtxo reference in batch: ${key}`);
		}
		seen.add(key);
	}
}

function assertCollateralNotInBatch<T extends { smartContractUtxo: UTxO }>(items: T[], collateralUtxo: UTxO): void {
	const collateralKey = refKey(collateralUtxo);
	for (const item of items) {
		if (refKey(item.smartContractUtxo) === collateralKey) {
			throw new Error(
				`Collateral UTxO overlaps with a script input (${collateralKey}); phase-1 Conway rules forbid this`,
			);
		}
	}
}

const DEFAULT_EX_UNITS = { mem: 7e6, steps: 3e9 } as const;

type ExUnits = { mem: number; steps: number };

type EvalAction = { tag: string; index: number; budget: ExUnits };

// evaluateTx returns the EXACT ex_units the PASS-1 (default-budget) tx consumed,
// with zero slack. The final PASS-2 tx is not byte-identical: every leg's
// declared ex_units changes (default → evaluated) and the fee changes, and both
// the fee and the full redeemer set are part of the PlutusV3 ScriptContext the
// validator processes. So phase-2 execution needs marginally more than the
// reported budget — a single-leg tx absorbs the drift, but a multi-leg batch
// serializes a much larger ScriptContext and tips over with a tiny uniform
// overspend across every leg (observed on preprod: ~0.01% steps / ~0.4% mem).
// Over-declaring is safe: phase-2 only rejects UNDER-declaration, and the fee is
// recomputed by mesh's automatic-fee pass over the inflated budgets. 10% covers
// the drift with wide margin while staying well under the per-tx ex-units max
// for the batch sizes we build.
const EX_UNITS_SAFETY_NUM = 11n;
const EX_UNITS_SAFETY_DEN = 10n;

function withExUnitsSafetyMargin(budget: ExUnits): ExUnits {
	return {
		mem: Number((BigInt(Math.ceil(budget.mem)) * EX_UNITS_SAFETY_NUM) / EX_UNITS_SAFETY_DEN),
		steps: Number((BigInt(Math.ceil(budget.steps)) * EX_UNITS_SAFETY_NUM) / EX_UNITS_SAFETY_DEN),
	};
}

/**
 * Map evaluateTx SPEND budgets onto our per-item sortedItems index.
 *
 * `action.index` from evaluateTx is the BODY-CANONICAL position of the script
 * input (Cardano sorts ALL inputs — script + wallet — by `(txHash, outputIndex)`
 * before assigning redeemer indices). If a wallet UTxO sorts between two
 * script UTxOs, the script inputs end up at non-contiguous body positions
 * (e.g. {0, 2, 4} instead of {0, 1, 2}). Indexing the map directly by
 * `action.index` then misaligns with our local `sortedItems[idx]` which always
 * runs `0..N-1`.
 *
 * Since we pre-sort `sortedItems` by the same canonical key the ledger uses,
 * the I-th canonically-sorted script input IS sortedItems[I]. So we sort the
 * SPEND actions by `action.index` ascending and key the budget map by their
 * position in that sort — which is exactly the index callers want.
 */
function buildSpendBudgetMap(evaluated: EvalAction[]): Map<number, ExUnits> {
	const map = new Map<number, ExUnits>();
	const spendActionsSortedByBodyIndex = evaluated
		.filter((action) => action.tag === 'SPEND')
		.sort((a, b) => a.index - b.index);
	for (let i = 0; i < spendActionsSortedByBodyIndex.length; i++) {
		map.set(i, withExUnitsSafetyMargin(spendActionsSortedByBodyIndex[i].budget));
	}
	return map;
}

function stringifyErrorForRetry(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name} ${error.message} ${error.stack ?? ''}`;
	}
	if (error != null && typeof error === 'object') {
		try {
			return JSON.stringify(error);
		} catch {
			return '[unserializable error object]';
		}
	}
	return String(error);
}

export function shouldRetryWithoutOptionalWalletSplitter(params: {
	walletUtxoCount: number;
	includeWalletSplitter: boolean;
	error: unknown;
}): boolean {
	if (!params.includeWalletSplitter || params.walletUtxoCount !== 1) {
		return false;
	}
	const message = stringifyErrorForRetry(params.error).toLowerCase();
	return (
		message.includes('utxo fully depleted') ||
		message.includes('inputselectionerror') ||
		message.includes('insufficient balance') ||
		message.includes('not enough ada') ||
		message.includes('not enough lovelace')
	);
}

/**
 * Build a single tx that spends N V2 smart-contract UTxOs of the same
 * interaction type. Each spend gets its own `Spend` redeemer (alt computed
 * from `item.type`) and its own continuation `.txOut(...).txOutInlineDatumValue(...)`
 * carrying the per-item `newInlineDatum`.
 *
 * Two-pass tx build: pass 1 attaches default exUnits, calls `evaluateTx`, and
 * collects the per-spend budget. Pass 2 rebuilds with the chain-computed
 * exUnits. We pre-sort `sortedItems` canonically (same key the ledger uses
 * for body input ordering) and remap evaluateTx's body-canonical SPEND
 * indices back to per-item array indices via `buildSpendBudgetMap`. That
 * remap is what lets wallet UTxOs interleave with script UTxOs in body
 * position without misaligning the exUnits.
 *
 * The on-chain semantics map to `vested_pay.ak`'s `Action` redeemers: each
 * input runs the validator once with its own `own_ref` and the matching
 * continuation output (looked up via `script_output_with_datum`). For
 * `SubmitResult`, `AuthorizeWithdrawal`, `AuthorizeRefund`, and
 * `SetRefundRequested` the validator does NOT call `outputs_with_reference_tag`,
 * so continuation outputs do not need to be tagged with own_ref — the linkage
 * is by datum-field match (buyer, seller, references, times, agent identifier).
 */
export async function generateMasumiSmartContractBatchInteractionTransactionAutomaticFees(
	blockchainProvider: BlockfrostProvider,
	network: Network,
	script: { version: LanguageVersion; code: string },
	walletAddress: string,
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	items: BatchInteractionItem[],
	invalidBefore: number,
	invalidAfter: number,
	rpcApiKey?: string,
): Promise<string> {
	if (items.length === 0) {
		throw new Error('no items in batch');
	}
	assertDistinctRefs(items);
	assertDistinctReferenceSignatures(items);
	assertCollateralNotInBatch(items, collateralUtxo);

	if (rpcApiKey) {
		// Mesh hardcodes the imported DEFAULT_V*_COST_MODEL_LIST arrays into
		// hashScriptData(); without a fresh sync the ledger may reject submission
		// with PPViewHashesDontMatch. Helper is memoized 5min, cheap to call.
		await syncMeshCostModelsFromChainV2(rpcApiKey);
	}

	// Re-use the mesh-format protocol params just populated by
	// `syncMeshCostModelsFromChainV2` above; the inner builder also reads the
	// same cache. Previously this branch unconditionally hit
	// `fetchProtocolParameters()` AGAIN — a second Blockfrost roundtrip when
	// the cache was already warm from the line just above. Cache miss falls
	// back to the same live fetch, but the steady-state common case is a
	// cheap memory read.
	let coinsPerUtxoSize: number = FALLBACK_COINS_PER_UTXO_SIZE;
	try {
		const cached = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
		const protocolParams =
			cached != null ? (cached as { coinsPerUtxoSize?: number }) : await blockchainProvider.fetchProtocolParameters();
		if (protocolParams.coinsPerUtxoSize != null) {
			coinsPerUtxoSize = protocolParams.coinsPerUtxoSize;
		}
	} catch (error) {
		logger.warn('Failed to fetch protocol parameters for batch interaction; using fallback coinsPerUtxoSize', {
			fallbackCoinsPerUtxoSize: coinsPerUtxoSize,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const sortedItems = sortItemsCanonical(items);

	async function buildTwoPass(includeWalletSplitter: boolean): Promise<string> {
		const evaluationTx = await buildBatchInteractionTx(
			blockchainProvider,
			network,
			script,
			walletAddress,
			collateralUtxo,
			walletUtxos,
			sortedItems,
			invalidBefore,
			invalidAfter,
			// First pass: every item gets the default budget.
			new Map(sortedItems.map((_, idx) => [idx, { ...DEFAULT_EX_UNITS }])),
			coinsPerUtxoSize,
			rpcApiKey,
			{ includeWalletSplitter },
		);

		const evaluated = (await blockchainProvider.evaluateTx(evaluationTx)) as EvalAction[];
		const spendBudgets = buildSpendBudgetMap(evaluated);

		for (let idx = 0; idx < sortedItems.length; idx++) {
			if (!spendBudgets.has(idx)) {
				throw new Error(
					`evaluateTx did not return a SPEND budget for batch index ${idx}; ` +
						`got ${evaluated.length} action(s) of which ` +
						`${evaluated.filter((a) => a.tag === 'SPEND').length} were SPEND`,
				);
			}
		}

		return await buildBatchInteractionTx(
			blockchainProvider,
			network,
			script,
			walletAddress,
			collateralUtxo,
			walletUtxos,
			sortedItems,
			invalidBefore,
			invalidAfter,
			spendBudgets,
			coinsPerUtxoSize,
			rpcApiKey,
			{ includeWalletSplitter },
		);
	}

	try {
		return await buildTwoPass(true);
	} catch (error) {
		if (
			!shouldRetryWithoutOptionalWalletSplitter({
				walletUtxoCount: walletUtxos.length,
				includeWalletSplitter: true,
				error,
			})
		) {
			throw error;
		}
		logger.warn('V2 batch interaction optional wallet splitter depleted fee input; retrying without splitter', {
			walletUtxoCount: walletUtxos.length,
			itemCount: sortedItems.length,
			error: error instanceof Error ? { name: error.name, message: error.message } : error,
		});
		return await buildTwoPass(false);
	}
}

async function buildBatchInteractionTx(
	blockchainProvider: IFetcher,
	network: Network,
	script: { version: LanguageVersion; code: string },
	walletAddress: string,
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	sortedItems: BatchInteractionItem[],
	invalidBefore: number,
	invalidAfter: number,
	exUnitsByIndex: Map<number, ExUnits>,
	coinsPerUtxoSize: number,
	rpcApiKey?: string,
	options: { includeWalletSplitter?: boolean } = {},
): Promise<string> {
	// Reuse the cached mesh-format chain params populated by
	// syncMeshCostModelsFromChain (see comment in the outer Automatic builder).
	// Fall back to a live fetch only on cache miss / no rpcApiKey supplied.
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));
	const txBuilder = new MeshTxBuilder({ fetcher: blockchainProvider });
	txBuilder.protocolParams(protocolParameters);

	const smartContractAddress: unknown = resolvePlutusScriptAddress(
		script,
		convertNetworkToId(convertMeshNetworkToPrismaNetwork(network)),
	);
	if (typeof smartContractAddress !== 'string') {
		throw new TypeError(`Expected resolvePlutusScriptAddress to return a string, got: ${typeof smartContractAddress}`);
	}

	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

	// Per-input spend legs. Each call chain in this loop produces ONE
	// (input, redeemer, exUnits) tuple in the canonical-sort order. We DON'T
	// emit the continuation .txOut(...) inside the per-input chain — mesh
	// associates the spending script with the active input, and emitting the
	// .txOut here would cause mesh to attribute the output's value to that
	// input's chain. Instead we emit outputs in a separate loop AFTER all
	// inputs so the script association is unambiguous.
	for (let idx = 0; idx < sortedItems.length; idx++) {
		const item = sortedItems[idx];
		const exUnits = exUnitsByIndex.get(idx) ?? { ...DEFAULT_EX_UNITS };
		const scriptRefSize = item.smartContractUtxo.output.scriptRef
			? item.smartContractUtxo.output.scriptRef.length / 2
			: 0;
		txBuilder
			.spendingPlutusScript(script.version)
			.txIn(
				item.smartContractUtxo.input.txHash,
				item.smartContractUtxo.input.outputIndex,
				item.smartContractUtxo.output.amount,
				item.smartContractUtxo.output.address,
				scriptRefSize,
			)
			.txInScript(script.code)
			.txInRedeemerValue(generateRedeemerData(item.type), 'Mesh', exUnits)
			.txInInlineDatumPresent();
	}

	// Single shared collateral input. Conway phase-1 requires
	// totalCollateral >= sum(scriptFee) * collateralPercentage / 100, where
	// scriptFee grows linearly with per-leg ex_units. We derive the value from
	// the actual evaluated budgets in `exUnitsByIndex` (default budgets on the
	// first build pass, chain-evaluated on the second), apply a safety
	// multiplier, and floor at 3 ADA. See `deriveTotalCollateral` at the top
	// of this file for the math; see batch-helpers `computeCollateralFromExUnits`
	// for the underlying Conway formula.
	const totalCollateral = deriveTotalCollateral(
		Array.from(exUnitsByIndex.values()),
		protocolParameters,
		lovelaceFromUtxo(collateralUtxo),
	);
	txBuilder
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral(totalCollateral);

	// Per-input continuation outputs. Each item gets its own
	// `.txOut(...).txOutInlineDatumValue(item.newInlineDatum)`; we compute the
	// per-output value (with optional min-UTxO top-up) by walking the same
	// canonical-sorted item list.
	for (const item of sortedItems) {
		const nativeTokenCount = item.nativeTokenCount ?? getNativeTokenCount(item.smartContractUtxo.output.amount);
		const minUtxoResult = calculateMinUtxo({
			datum: item.newInlineDatum,
			nativeTokenCount,
			coinsPerUtxoSize,
			includeBuffers: true,
		});
		const currentLovelace = getLovelaceFromAmounts(item.smartContractUtxo.output.amount);
		const topUpAmount = calculateTopUpAmount(currentLovelace, minUtxoResult.minUtxoLovelace);
		const outputAmount: Asset[] = [...item.smartContractUtxo.output.amount];

		if (topUpAmount > 0n) {
			logger.info('Applying min-UTXO top-up for V2 batch smart contract interaction', {
				type: item.type,
				currentLovelace: currentLovelace.toString(),
				requiredMinUtxo: minUtxoResult.minUtxoLovelace.toString(),
				topUpAmount: topUpAmount.toString(),
				nativeTokenCount,
				coinsPerUtxoSize,
				txHash: item.smartContractUtxo.input.txHash,
				outputIndex: item.smartContractUtxo.input.outputIndex,
			});
			const lovelaceIndex = outputAmount.findIndex((a) => a.unit === '' || a.unit.toLowerCase() === 'lovelace');
			if (lovelaceIndex >= 0) {
				outputAmount[lovelaceIndex] = {
					...outputAmount[lovelaceIndex],
					quantity: minUtxoResult.minUtxoLovelace.toString(),
				};
			} else {
				outputAmount.push({
					unit: 'lovelace',
					quantity: minUtxoResult.minUtxoLovelace.toString(),
				});
			}
		}

		txBuilder.txOut(smartContractAddress, outputAmount).txOutInlineDatumValue(item.newInlineDatum);
	}

	// Conditional wallet "splitter" output: an explicit pure-ADA self-send
	// emitted ONLY when the wallet has exactly ONE fee-eligible UTxO (the
	// genuine trap-risk floor). Threshold rationale:
	//
	//   - `walletUtxos.length === 0` → tx cannot build; splitter would not
	//     help and the build failure is the correct signal.
	//   - `walletUtxos.length === 1` → mesh consumes the one fee input,
	//     emits one change. Without splitter the wallet ends at
	//     [collateral, change] = exactly the 2-UTxO floor — any phase-2
	//     failure or external consolidation drops below 2 and re-triggers
	//     `ensureCollateralReady` prep. Splitter adds a 3rd UTxO so the
	//     wallet has a buffer.
	//   - `walletUtxos.length >= 2` → mesh's natural behavior post-tx is
	//     at least [collateral, change] = 2 UTxOs regardless of how many
	//     fee inputs it picks. Splitter is over-emission; firing it adds
	//     an extra output that competes with the script continuation
	//     outputs for mesh's wallet selection and triggers
	//     `[batch-fallback]` on dense batches (the regression that
	//     surfaced the `<= 2` threshold being too loose).
	//
	// The collateral input is excluded from `walletUtxos` by the service
	// layer (each service's `.filter(...)` walk removes `collateralUtxo`
	// before passing here), so `walletUtxos.length` is the count of
	// FEE-ELIGIBLE wallet UTxOs.
	//
	// See `batch-helpers.ts WALLET_SPLITTER_LOVELACE` for the lifecycle
	// rationale and the cross-module invariant
	// `WALLET_SPLITTER_LOVELACE >= COLLATERAL_RESERVE_LOVELACE`.
	if ((options.includeWalletSplitter ?? true) && walletUtxos.length === 1) {
		txBuilder.txOut(walletAddress, [{ unit: 'lovelace', quantity: WALLET_SPLITTER_LOVELACE.toString() }]);
	}

	// Hand the candidate wallet UTxOs to Mesh's coin selector instead of
	// force-adding every one. Force-adding (a) blows tx size on fragmented
	// wallets and (b) bypasses caller-supplied exclusion lists (e.g.
	// `pickBatchCollateral`'s `excludeSpendingInputs`) — the service layer
	// pre-filters `walletUtxos` to exclude collateral + spending refs so
	// passing the full list to `selectUtxosFrom` is safe and lets Mesh pick
	// only what's needed for fees + change.
	txBuilder.selectUtxosFrom(walletUtxos);

	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.invalidBefore(invalidBefore)
		.invalidHereafter(invalidAfter)
		.changeAddress(walletAddress)
		.setNetwork(network)
		.metadataValue(674, {
			// One array element per leg. CIP-20 `msg` is an array of ≤64-byte
			// strings; joining all leg type names into ONE string overflowed the
			// 64-byte metadatum limit for realistic batch sizes and made every
			// build throw, silently forcing single-item fallback.
			msg: ['Masumi', ...sortedItems.map((i) => i.type)],
		})
		.complete();
}

/**
 * One withdraw leg of a V2 batch-withdraw transaction. Each item produces:
 *   - one Spend input + its `Withdraw` or `WithdrawRefund` redeemer,
 *   - one collection output to `collectionAddress` carrying `collectAssets`,
 *   - one optional fee output (V2 has none → always `null`),
 *   - one optional collateral-return output to the buyer.
 *
 * Every collection / fee / collateral-return output's inline datum is
 * `mOutputReference(item.smartContractUtxo.input.txHash, item.smartContractUtxo.input.outputIndex)`.
 * The V2 validator's `outputs_with_reference_tag(self.outputs, own_ref, default, return_addr)`
 * filters outputs by `output.datum == own_ref` AND `output.address == expected`,
 * which is what ties each tagged output back to its specific spending input
 * even when N inputs share the same script and the same return-address shape.
 *
 * Tagging is unconditional in V2 — emitting outputs without the tag would
 * leave them invisible to the validator's output filter and break per-input
 * value accounting. If a future flow needs untagged outputs it should use a
 * separate builder.
 */
export type BatchWithdrawItem = {
	type: 'CollectCompleted' | 'CollectRefund';
	smartContractUtxo: UTxO;
	collection: { collectAssets: Asset[]; collectionAddress: string };
	/** V2 has no protocol fee — pass `null`. The field stays general so future flows can attach one. */
	fee: { feeAssets: Asset[]; feeAddress: string } | null;
	collateralReturn: { lovelace: bigint; address: string } | null;
};

export async function generateMasumiSmartContractBatchWithdrawTransactionAutomaticFees(
	blockchainProvider: BlockfrostProvider,
	network: Network,
	script: { version: LanguageVersion; code: string },
	walletAddress: string,
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	items: BatchWithdrawItem[],
	invalidBefore: number,
	invalidAfter: number,
	rpcApiKey?: string,
): Promise<string> {
	if (items.length === 0) {
		throw new Error('no items in batch');
	}
	assertDistinctRefs(items);
	assertDistinctReferenceSignatures(items);
	assertCollateralNotInBatch(items, collateralUtxo);

	if (rpcApiKey) {
		await syncMeshCostModelsFromChainV2(rpcApiKey);
	}

	const sortedItems = sortItemsCanonical(items);

	const evaluationTx = await buildBatchWithdrawTx(
		blockchainProvider,
		network,
		script,
		walletAddress,
		collateralUtxo,
		walletUtxos,
		sortedItems,
		invalidBefore,
		invalidAfter,
		new Map(sortedItems.map((_, idx) => [idx, { ...DEFAULT_EX_UNITS }])),
		rpcApiKey,
	);

	const evaluated = (await blockchainProvider.evaluateTx(evaluationTx)) as EvalAction[];
	const spendBudgets = buildSpendBudgetMap(evaluated);

	for (let idx = 0; idx < sortedItems.length; idx++) {
		if (!spendBudgets.has(idx)) {
			throw new Error(
				`evaluateTx did not return a SPEND budget for batch withdraw index ${idx}; ` +
					`got ${evaluated.length} action(s) of which ` +
					`${evaluated.filter((a) => a.tag === 'SPEND').length} were SPEND`,
			);
		}
	}

	return await buildBatchWithdrawTx(
		blockchainProvider,
		network,
		script,
		walletAddress,
		collateralUtxo,
		walletUtxos,
		sortedItems,
		invalidBefore,
		invalidAfter,
		spendBudgets,
		rpcApiKey,
	);
}

async function buildBatchWithdrawTx(
	blockchainProvider: IFetcher,
	network: Network,
	script: { version: LanguageVersion; code: string },
	walletAddress: string,
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	sortedItems: BatchWithdrawItem[],
	invalidBefore: number,
	invalidAfter: number,
	exUnitsByIndex: Map<number, ExUnits>,
	rpcApiKey?: string,
): Promise<string> {
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));
	const txBuilder = new MeshTxBuilder({ fetcher: blockchainProvider });
	txBuilder.protocolParams(protocolParameters);

	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

	for (let idx = 0; idx < sortedItems.length; idx++) {
		const item = sortedItems[idx];
		const exUnits = exUnitsByIndex.get(idx) ?? { ...DEFAULT_EX_UNITS };
		const scriptRefSize = item.smartContractUtxo.output.scriptRef
			? item.smartContractUtxo.output.scriptRef.length / 2
			: 0;
		txBuilder
			.spendingPlutusScript(script.version)
			.txIn(
				item.smartContractUtxo.input.txHash,
				item.smartContractUtxo.input.outputIndex,
				item.smartContractUtxo.output.amount,
				item.smartContractUtxo.output.address,
				scriptRefSize,
			)
			.txInScript(script.code)
			.txInRedeemerValue(generateRedeemerData(item.type), 'Mesh', exUnits)
			.txInInlineDatumPresent();
	}

	// Conway phase-1 collateral: derive from evaluated SPEND budgets. See the
	// comment in `buildBatchInteractionTx` and `deriveTotalCollateral` at the
	// top of this file for the rationale.
	const totalCollateral = deriveTotalCollateral(
		Array.from(exUnitsByIndex.values()),
		protocolParameters,
		lovelaceFromUtxo(collateralUtxo),
	);
	txBuilder
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral(totalCollateral);

	// Per-item collection / fee / collateral-return outputs. Each tagged output
	// MUST carry THAT item's own_ref — sharing a tag across items would let one
	// input's outputs satisfy another input's filter and break per-input value
	// accounting. See `outputs_with_reference_tag` in
	// smart-contracts/payment-v2/validators/vested_pay.ak.
	for (const item of sortedItems) {
		const ownRefDatum = mOutputReference(item.smartContractUtxo.input.txHash, item.smartContractUtxo.input.outputIndex);

		txBuilder.txOut(item.collection.collectionAddress, item.collection.collectAssets);
		txBuilder.txOutInlineDatumValue(ownRefDatum);

		if (item.fee != null) {
			txBuilder.txOut(item.fee.feeAddress, item.fee.feeAssets);
			txBuilder.txOutInlineDatumValue(ownRefDatum);
		}

		if (item.collateralReturn != null && item.collateralReturn.lovelace > 0n) {
			txBuilder.txOut(item.collateralReturn.address, [
				{
					unit: 'lovelace',
					quantity: item.collateralReturn.lovelace.toString(),
				},
			]);
			txBuilder.txOutInlineDatumValue(ownRefDatum);
		}
	}

	// Conditional wallet "splitter" output — same rationale as in
	// buildBatchInteractionTx. Emit ONLY when wallet has exactly one
	// fee-eligible UTxO (the genuine trap-risk floor).
	if (walletUtxos.length === 1) {
		txBuilder.txOut(walletAddress, [{ unit: 'lovelace', quantity: WALLET_SPLITTER_LOVELACE.toString() }]);
	}

	// See the matching note in buildBatchInteractionTx: hand the candidate
	// wallet UTxOs to Mesh's coin selector instead of force-adding every one.
	txBuilder.selectUtxosFrom(walletUtxos);

	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.invalidBefore(invalidBefore)
		.invalidHereafter(invalidAfter)
		.changeAddress(walletAddress)
		.setNetwork(network)
		.metadataValue(674, {
			// One array element per leg. CIP-20 `msg` is an array of ≤64-byte
			// strings; joining all leg type names into ONE string overflowed the
			// 64-byte metadatum limit for realistic batch sizes and made every
			// build throw, silently forcing single-item fallback.
			msg: ['Masumi', ...sortedItems.map((i) => i.type)],
		})
		.complete();
}
