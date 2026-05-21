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
import { resolvePlutusScriptAddress } from '@meshsdk/core-cst';
import { convertNetworkToId } from '@masumi/payment-core';
import type { Network as PrismaNetwork } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';
import { calculateMinUtxo, calculateTopUpAmount, getLovelaceFromAmounts, getNativeTokenCount } from '@/utils/min-utxo';
import { getCachedChainProtocolParameters, syncMeshCostModelsFromChain } from '@/utils/mesh-cost-model-sync';
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
 * Stable lex order on `(txHash, outputIndex)`. Mesh sorts inputs internally
 * using the same canonical order before computing the `Spend` redeemer index,
 * so by sorting our items the same way, the per-item array index in our local
 * loop is the same as the `redeemerData.index` mesh attaches in the body. That
 * is what lets us match `evaluateTx`'s `index` field back to a specific item.
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

function buildSpendBudgetMap(evaluated: EvalAction[]): Map<number, ExUnits> {
	const map = new Map<number, ExUnits>();
	for (const action of evaluated) {
		if (action.tag === 'SPEND') {
			map.set(action.index, action.budget);
		}
	}
	return map;
}

/**
 * Build a single tx that spends N V2 smart-contract UTxOs of the same
 * interaction type. Each spend gets its own `Spend` redeemer (alt computed
 * from `item.type`) and its own continuation `.txOut(...).txOutInlineDatumValue(...)`
 * carrying the per-item `newInlineDatum`.
 *
 * Two-pass tx build: pass 1 attaches default exUnits, calls `evaluateTx`, and
 * collects the per-spend budget. Pass 2 rebuilds with the chain-computed
 * exUnits, keeping the same canonical sort so `evaluateTx`'s
 * `index` field aligns with our per-item index.
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
	assertCollateralNotInBatch(items, collateralUtxo);

	if (rpcApiKey) {
		// Mesh hardcodes the imported DEFAULT_V*_COST_MODEL_LIST arrays into
		// hashScriptData(); without a fresh sync the ledger may reject submission
		// with PPViewHashesDontMatch. Helper is memoized 5min, cheap to call.
		await syncMeshCostModelsFromChain(rpcApiKey);
	}

	let coinsPerUtxoSize: number = FALLBACK_COINS_PER_UTXO_SIZE;
	try {
		const protocolParams = await blockchainProvider.fetchProtocolParameters();
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
	);
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

	// Single shared collateral input. Collateral bumping for many-script-input
	// txs is deferred to a later phase; for now keep at 3 ADA (matches the
	// V1-pinned single-item builder).
	txBuilder.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex).setTotalCollateral('3000000');

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

	// Pure wallet inputs for fee / change. Same loop as the single-item builder.
	for (const utxo of walletUtxos) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}

	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.invalidBefore(invalidBefore)
		.invalidHereafter(invalidAfter)
		.changeAddress(walletAddress)
		.setNetwork(network)
		.metadataValue(674, {
			msg: ['Masumi', sortedItems.map((i) => i.type).join(',')],
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
 * When `tagOutputsWithOwnRef === true`, each collection / fee / collateral-return
 * output's inline datum is `mOutputReference(item.smartContractUtxo.input.txHash, item.smartContractUtxo.input.outputIndex)`.
 * The V2 validator's `outputs_with_reference_tag(self.outputs, own_ref, default, return_addr)`
 * filters outputs by `output.datum == own_ref` AND `output.address == expected`,
 * which is what ties each tagged output back to its specific spending input
 * even when N inputs share the same script and the same return-address shape.
 */
export type BatchWithdrawItem = {
	type: 'CollectCompleted' | 'CollectRefund';
	smartContractUtxo: UTxO;
	collection: { collectAssets: Asset[]; collectionAddress: string };
	/** V2 has no protocol fee — pass `null`. The field stays general so future flows can attach one. */
	fee: { feeAssets: Asset[]; feeAddress: string } | null;
	collateralReturn: { lovelace: bigint; address: string } | null;
	/** V2: true. Required when the on-chain datum has buyer/seller return addresses; safe to leave on otherwise. */
	tagOutputsWithOwnRef: boolean;
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
	assertCollateralNotInBatch(items, collateralUtxo);

	if (rpcApiKey) {
		await syncMeshCostModelsFromChain(rpcApiKey);
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

	txBuilder.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex).setTotalCollateral('3000000');

	// Per-item collection / fee / collateral-return outputs. Each tagged output
	// MUST carry THAT item's own_ref — sharing a tag across items would let one
	// input's outputs satisfy another input's filter and break per-input value
	// accounting. See `outputs_with_reference_tag` in
	// smart-contracts/payment-v2/validators/vested_pay.ak.
	for (const item of sortedItems) {
		const ownRefDatum = mOutputReference(item.smartContractUtxo.input.txHash, item.smartContractUtxo.input.outputIndex);

		txBuilder.txOut(item.collection.collectionAddress, item.collection.collectAssets);
		if (item.tagOutputsWithOwnRef) {
			txBuilder.txOutInlineDatumValue(ownRefDatum);
		}

		if (item.fee != null) {
			txBuilder.txOut(item.fee.feeAddress, item.fee.feeAssets);
			if (item.tagOutputsWithOwnRef) {
				txBuilder.txOutInlineDatumValue(ownRefDatum);
			}
		}

		if (item.collateralReturn != null && item.collateralReturn.lovelace > 0n) {
			txBuilder.txOut(item.collateralReturn.address, [
				{
					unit: 'lovelace',
					quantity: item.collateralReturn.lovelace.toString(),
				},
			]);
			if (item.tagOutputsWithOwnRef) {
				txBuilder.txOutInlineDatumValue(ownRefDatum);
			}
		}
	}

	for (const utxo of walletUtxos) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}

	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.invalidBefore(invalidBefore)
		.invalidHereafter(invalidAfter)
		.changeAddress(walletAddress)
		.setNetwork(network)
		.metadataValue(674, {
			msg: ['Masumi', sortedItems.map((i) => i.type).join(',')],
		})
		.complete();
}
