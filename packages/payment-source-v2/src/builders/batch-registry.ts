// Mesh SDK pinning: this file lives in the V2 package and MUST resolve to the
// V2 mesh line (`@meshsdk/core@1.9.0-beta.102`). The V2 registry policy hashes
// the validator script with V2-cost-model awareness and the asset-name layout
// is specific to the V2 mint validator. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import {
	type BlockfrostProvider,
	type IFetcher,
	type LanguageVersion,
	MeshTxBuilder,
	type Network,
	type UTxO,
} from '@meshsdk/core';
import { SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { getCachedChainProtocolParameters } from '@/utils/mesh-cost-model-sync';
import { syncMeshCostModelsFromChainV2 } from '../utils/mesh-cost-model-sync';
import { deriveTotalCollateral, lovelaceFromUtxo, WALLET_SPLITTER_LOVELACE } from './batch-helpers';

// V2 mint contract `Action` enum: MintAction=0, UpdateAction=1, BurnAction=2.
// See smart-contracts/registry-v2/validators/mint.ak.
const V2_MINT_REDEEMER_ALTERNATIVE = 0;
const V2_UPDATE_REDEEMER_ALTERNATIVE = 1;
const V2_BURN_REDEEMER_ALTERNATIVE = 2;

export type RegistryMetadata = {
	[key: string]: string | string[] | RegistryMetadata | RegistryMetadata[] | undefined;
};

/**
 * One mint leg of a V2 registry batch mint transaction.
 *
 * - `firstUtxo` MUST be a tx input on the resulting transaction; the V2 mint
 *   validator computes `blake2b_224(tx_id || index_be4)` for every spent input
 *   and requires the 28-byte root segment of every minted asset name to match
 *   one of those root hashes (see `every_asset_is_an_initial_mint` /
 *   `input_root_hash` in smart-contracts/registry-v2/validators/mint.ak).
 * - `assetName` MUST already be the V2 32-byte layout produced by
 *   `generateRegistryAssetNameV2(firstUtxo)`: one nonce byte > 0x0f, the
 *   28-byte root hash, three zero version bytes. Mismatch fails the validator.
 * - `metadata` lands in the CIP-25 NFT metadata block under the policy id.
 */
export type BatchRegistryMintItem = {
	recipientWalletAddress: string;
	fundingLovelace: string;
	assetName: string;
	firstUtxo: UTxO;
	metadata: RegistryMetadata;
};

/**
 * One burn leg of a V2 registry batch deregister transaction.
 *
 * - `assetUtxo` MUST hold exactly one unit of `policyId + assetName`. The
 *   mesh-sdk auto-balancer would otherwise rebuild the asset back into change.
 * - The burn redeemer is alt=2 (V2 `BurnAction`); the validator just checks
 *   that every entry in the policy bucket has quantity == -1, so multi-burn
 *   under one shared redeemer works natively.
 */
export type BatchRegistryBurnItem = {
	assetName: string;
	assetUtxo: UTxO;
};

/**
 * One update leg of a V2 registry batch update transaction: burn the current
 * asset and mint its version-bumped replacement in the same tx, both under one
 * shared `UpdateAction` redeemer (alt=1).
 *
 * - `assetUtxo` MUST hold exactly one unit of `policyId + oldAssetName` and MUST
 *   be a tx input — spending it both burns the old asset and authorizes the
 *   update (possession is authority; the V2 mint policy is permissionless).
 * - `newAssetName` MUST be `bumpRegistryAssetNameVersionV2(oldAssetName)`: same
 *   1-byte nonce + 28-byte root, version incremented by one. The validator pairs
 *   every burn to a mint via `asset_name_continues_with_next_version`, so a
 *   mismatch fails the UpdateAction check.
 * - `metadata` lands in the CIP-25 block for the NEW asset name.
 */
export type BatchRegistryUpdateItem = {
	oldAssetName: string;
	newAssetName: string;
	assetUtxo: UTxO;
	recipientWalletAddress: string;
	fundingLovelace: string;
	metadata: RegistryMetadata;
};

const DEFAULT_EX_UNITS = SERVICE_CONSTANTS.SMART_CONTRACT.defaultExUnits;
const DEFAULT_EX_UNITS_FALLBACK = { mem: 7e6, steps: 3e9 } as const;

type ExUnits = { mem: number; steps: number };

type EvalAction = { tag: string; index: number; budget: ExUnits };

function refKey(utxo: UTxO): string {
	return `${utxo.input.txHash}#${utxo.input.outputIndex}`;
}

/**
 * Throws when `collateralUtxo` overlaps with any `spendingInput`. Conway
 * phase-1 rejects `collateralInputs ∩ inputs ≠ ∅`; the on-chain symptom is an
 * opaque `EvaluationFailure: ScriptFailures: {}` from ogmios that is very
 * hard to diagnose post-hoc, so failing fast off-chain is much friendlier.
 *
 * Used by the BURN builder where asset UTxOs MUST be in `inputs` for the
 * wallet to have authority to consume them — collateral overlapping with an
 * asset UTxO would either fail phase-1 or, if mesh routed it as collateral
 * only, would leave the asset un-spent on success and break the mint balance.
 *
 * NOT used by the MINT builder: mint-only txs tolerate collateral/input
 * overlap (Mesh-SDK 1.9 routes `.txIn(...)` and `.txInCollateral(...)` into
 * separate body fields and dedupes the collateral side at assembly time —
 * the V1 single-tx register builder relies on this same pattern, passing the
 * same UTxO as both `firstUtxo` and `collateralUtxo`). Skipping the check
 * there is what allows a 1-UTxO wallet to drive a 1-item mint batch instead
 * of deferring forever.
 */
function assertCollateralNotInInputs(collateralUtxo: UTxO, spendingInputs: UTxO[]): void {
	const collateralKey = refKey(collateralUtxo);
	for (const utxo of spendingInputs) {
		if (refKey(utxo) === collateralKey) {
			throw new Error(
				`Collateral UTxO overlaps with a spending input (${collateralKey}); phase-1 Conway rules forbid this`,
			);
		}
	}
}

function assertDistinctAssetNames(assetNames: string[]): void {
	const seen = new Set<string>();
	for (const name of assetNames) {
		if (seen.has(name)) {
			throw new Error(`Duplicate assetName in batch: ${name}`);
		}
		seen.add(name);
	}
}

function findMintExUnits(evaluated: EvalAction[]): ExUnits | undefined {
	// The V2 mint policy is a single Plutus script with a single shared
	// redeemer for the whole batch — `evaluateTx` returns exactly one MINT
	// entry regardless of how many assets are minted under the policy.
	for (const action of evaluated) {
		if (action.tag === 'MINT') {
			return action.budget;
		}
	}
	return undefined;
}

/**
 * Build a single tx that mints N V2 registry NFTs under the same policy. One
 * shared `MintAction` redeemer is attached to the policy; the validator checks
 * each minted asset name against the spent inputs' root hashes, so every
 * `item.firstUtxo` must appear as a tx input.
 *
 * The builder de-dupes `firstUtxo`s against `walletUtxos` (a `firstUtxo` may
 * itself be the wallet's collateral / change source). Combined CIP-25 metadata
 * is emitted under one `metadataValue(721, ...)` block keyed by policy id.
 *
 * Note: this builder takes optional `exUnits`; callers wanting a two-pass
 * automatic-fee build can call it once with `undefined`, run `evaluateTx`,
 * then call again with the chain-computed budget. (The V2 service layer will
 * own that loop in Phase 2 — keeping the API symmetric with V1's
 * single-mint shape.)
 */
export async function generateRegistryBatchMintTransaction(
	blockchainProvider: IFetcher,
	network: Network,
	script: { version: LanguageVersion; code: string },
	mintingWalletAddress: string,
	policyId: string,
	items: BatchRegistryMintItem[],
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	exUnits: ExUnits = DEFAULT_EX_UNITS,
	rpcApiKey?: string,
): Promise<string> {
	if (items.length === 0) {
		throw new Error('no items in batch');
	}
	assertDistinctAssetNames(items.map((item) => item.assetName));
	// Intentionally NOT calling `assertCollateralNotInInputs(collateral,
	// firstUtxos)` here: mint-only txs tolerate the overlap (mesh routes
	// `.txIn(...)` and `.txInCollateral(...)` into separate body fields, and
	// the V1 single-tx register builder already exploits this to let a
	// 1-UTxO wallet drive a 1-asset mint by passing the same UTxO as both
	// `firstUtxo` and `collateralUtxo`). See the jsdoc on the helper above.

	if (rpcApiKey) {
		// See cost-model sync comment in batch-interaction.ts.
		await syncMeshCostModelsFromChainV2(rpcApiKey);
	}

	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));

	const txBuilder = new MeshTxBuilder({ fetcher: blockchainProvider });
	txBuilder.protocolParams(protocolParameters);
	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(mintingWalletAddress);

	// Mint context: attach the policy script + shared `MintAction` redeemer to
	// EVERY asset leg. Mesh's `mint()` flushes the previous mint item via
	// `queueMint()`, which requires that item to already carry its `scriptSource`
	// — so the script/redeemer must be set per leg, not once after the loop
	// (doing it once throws `queueMint: Missing mint script information` as soon
	// as the 2nd asset's `mint()` flushes the 1st). `mintPlutusScript()` must
	// also precede each `mint()` because it only arms `addingPlutusMint` for the
	// very next call. `queueMint` then merges every same-policy leg into one
	// bucket (it asserts the redeemer + scriptSource are identical across legs,
	// which they are), so the V2 validator still validates the bucket atomically
	// against a single `MintAction`.
	for (const item of items) {
		txBuilder
			.mintPlutusScript(script.version)
			.mint(SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity, policyId, item.assetName)
			.mintingScript(script.code)
			.mintRedeemerValue({ alternative: V2_MINT_REDEEMER_ALTERNATIVE, fields: [] }, 'Mesh', exUnits);
	}

	// Combined CIP-25 metadata: one `721` label with one policy id entry whose
	// per-asset map covers every minted name. `version: '1'` follows the V1
	// single-mint shape.
	const perAssetMetadata: Record<string, RegistryMetadata> = {};
	for (const item of items) {
		perAssetMetadata[item.assetName] = item.metadata;
	}
	txBuilder.metadataValue(SERVICE_CONSTANTS.METADATA.nftLabel, {
		[policyId]: perAssetMetadata,
		version: '1',
	});

	// Every `firstUtxo` MUST be a tx input — the validator derives each minted
	// asset's root_hash from `blake2b_224(firstUtxo.txId ++ output_index)`, so
	// excluding it would change the derived root_hash and fail the mint check.
	// Force-add only those; let Mesh's coin selector pick the remaining wallet
	// UTxOs needed for fees + change (avoids the previous pattern of force-adding
	// every wallet UTxO, which blew tx size on fragmented wallets and could
	// duplicate-spend with collateral refs).
	const inputRefs = new Set<string>();
	for (const item of items) {
		const key = refKey(item.firstUtxo);
		if (inputRefs.has(key)) continue;
		inputRefs.add(key);
		txBuilder.txIn(item.firstUtxo.input.txHash, item.firstUtxo.input.outputIndex);
	}
	// Also exclude the collateral from the coin-selector pool. Two reasons:
	//   1. Splitter-decision parity with the spend-path builders
	//      (batch-interaction.ts) where the SERVICE LAYER filters collateral
	//      out of `walletUtxos` before passing to the builder. The mint
	//      callers (`registry/register/service.ts`, `registry-inbox/register/service.ts`)
	//      pass `spendableUtxos` UNFILTERED, so the splitter check below
	//      would otherwise count the collateral input and over-emit a
	//      splitter on healthy wallets.
	//   2. Coin-selection correctness — mesh's `selectUtxosFrom` does NOT
	//      automatically exclude UTxOs declared via `.txInCollateral(...)`;
	//      if the wallet is fragmented enough that mesh picks the collateral
	//      UTxO as a regular fee input, the resulting tx has the same UTxO
	//      in both `inputs` and `collateral_inputs` and Conway phase-1
	//      rejects it.
	// The pre-existing tolerance for `firstUtxo == collateralUtxo` overlap
	// (see jsdoc on this function) is unaffected: when they coincide, the
	// ref is already in inputRefs via the firstUtxo add above.
	inputRefs.add(refKey(collateralUtxo));
	const walletUtxosForSelection = walletUtxos.filter((u) => !inputRefs.has(refKey(u)));
	if (walletUtxosForSelection.length > 0) {
		txBuilder.selectUtxosFrom(walletUtxosForSelection);
	}

	// Conway phase-1 collateral derived from the single shared MINT redeemer
	// budget. `exUnits` is either the default (first pass) or the chain-
	// evaluated MINT budget from `evaluateTx` (subsequent calls). See
	// `deriveTotalCollateral` for the math.
	const totalCollateral = deriveTotalCollateral([exUnits], protocolParameters, lovelaceFromUtxo(collateralUtxo));
	txBuilder
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral(totalCollateral);

	// One recipient output per minted asset: the asset itself + the funding
	// lovelace specified for this registration. Caller-supplied funding values
	// are already normalized to the per-registration minimum upstream.
	for (const item of items) {
		txBuilder.txOut(item.recipientWalletAddress, [
			{
				unit: policyId + item.assetName,
				quantity: SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity,
			},
			{
				unit: SERVICE_CONSTANTS.CARDANO.NATIVE_TOKEN,
				quantity: item.fundingLovelace,
			},
		]);
	}

	// Conditional wallet "splitter" output — emitted ONLY when the minting
	// wallet has exactly one FEE-ELIGIBLE UTxO (collateral + firstUtxos
	// excluded via `inputRefs`). Threshold is `=== 1`, not `<= 2`: at
	// length=2 mesh's natural change-emission already guarantees ≥2 UTxOs
	// post-tx (collateral untouched + change), so a splitter there is
	// over-emission. See `batch-helpers.ts WALLET_SPLITTER_LOVELACE` for
	// full rationale and the precise per-length analysis.
	if (walletUtxosForSelection.length === 1) {
		txBuilder.txOut(mintingWalletAddress, [{ unit: 'lovelace', quantity: WALLET_SPLITTER_LOVELACE.toString() }]);
	}

	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.setNetwork(network)
		.metadataValue(SERVICE_CONSTANTS.METADATA.masumiLabel, {
			msg: ['Masumi', 'RegisterAgent'],
		})
		.changeAddress(mintingWalletAddress)
		.complete();
}

/**
 * Build a single tx that burns N V2 registry NFTs under the same policy. One
 * shared `BurnAction` redeemer is attached to the policy; the validator checks
 * that every policy bucket entry has quantity == -1, so multi-burn is native.
 *
 * Two-pass `evaluateTx` is built in: pass 1 attaches default exUnits, pass 2
 * uses the chain-computed `MINT` budget.
 */
export async function generateRegistryBatchDeregisterTransactionAutomaticFees(
	blockchainProvider: BlockfrostProvider,
	network: Network,
	script: { version: LanguageVersion; code: string },
	walletAddress: string,
	policyId: string,
	items: BatchRegistryBurnItem[],
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	rpcApiKey?: string,
): Promise<string> {
	if (items.length === 0) {
		throw new Error('no items in batch');
	}
	assertDistinctAssetNames(items.map((item) => item.assetName));
	assertCollateralNotInInputs(
		collateralUtxo,
		items.map((item) => item.assetUtxo),
	);

	// Sanity-check: each assetUtxo must actually contain the asset being burned.
	// The mint validator only sees mint values; without the asset present in an
	// input the wallet has no authority to burn and mesh would auto-balance the
	// asset back into change.
	for (const item of items) {
		const unit = policyId + item.assetName;
		const hasAsset = item.assetUtxo.output.amount.some((asset) => asset.unit === unit && BigInt(asset.quantity) >= 1n);
		if (!hasAsset) {
			throw new Error(`assetUtxo ${refKey(item.assetUtxo)} does not contain asset ${unit}`);
		}
	}

	if (rpcApiKey) {
		await syncMeshCostModelsFromChainV2(rpcApiKey);
	}

	const evaluationTx = await buildBatchDeregisterTx(
		blockchainProvider,
		network,
		script,
		walletAddress,
		policyId,
		items,
		collateralUtxo,
		walletUtxos,
		DEFAULT_EX_UNITS_FALLBACK,
		rpcApiKey,
	);

	const evaluated = (await blockchainProvider.evaluateTx(evaluationTx)) as EvalAction[];
	const mintBudget = findMintExUnits(evaluated);
	if (mintBudget == null) {
		throw new Error(`evaluateTx did not return a MINT budget for batch deregister; got ${evaluated.length} action(s)`);
	}

	return await buildBatchDeregisterTx(
		blockchainProvider,
		network,
		script,
		walletAddress,
		policyId,
		items,
		collateralUtxo,
		walletUtxos,
		mintBudget,
		rpcApiKey,
	);
}

async function buildBatchDeregisterTx(
	blockchainProvider: IFetcher,
	network: Network,
	script: { version: LanguageVersion; code: string },
	walletAddress: string,
	policyId: string,
	items: BatchRegistryBurnItem[],
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	exUnits: ExUnits,
	rpcApiKey?: string,
): Promise<string> {
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));

	const txBuilder = new MeshTxBuilder({ fetcher: blockchainProvider });
	txBuilder.protocolParams(protocolParameters);
	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

	// Bring every asset-holding input into the tx FIRST so the wallet has the
	// assets available to burn. De-dupe against walletUtxos: in practice the
	// asset UTxO is usually already in the wallet UTxO set, so this would be
	// a duplicate `txIn` otherwise.
	const inputRefs = new Set<string>();
	for (const item of items) {
		const key = refKey(item.assetUtxo);
		if (inputRefs.has(key)) continue;
		inputRefs.add(key);
		txBuilder.txIn(item.assetUtxo.input.txHash, item.assetUtxo.input.outputIndex);
	}

	// Per-leg script + shared `BurnAction` redeemer attachment. See the mint
	// builder above for why this must be done inside the loop and not once
	// after it (Mesh's `mint()` flushes the prior leg via `queueMint()`, which
	// requires the leg's `scriptSource` to already be set, else it throws
	// `queueMint: Missing mint script information`).
	for (const item of items) {
		txBuilder
			.mintPlutusScript(script.version)
			.mint('-1', policyId, item.assetName)
			.mintingScript(script.code)
			.mintRedeemerValue({ alternative: V2_BURN_REDEEMER_ALTERNATIVE, fields: [] }, 'Mesh', exUnits);
	}

	// Hand remaining wallet UTxOs to Mesh's coin selector instead of force-adding
	// every one. Anything already declared as a `.txIn` above (via inputRefs) is
	// excluded so the selector doesn't try to add a duplicate. Same rationale as
	// the mint builder above — avoid bloated tx size and double-spend overlap
	// with collateral on fragmented wallets.
	inputRefs.add(refKey(collateralUtxo));
	const walletUtxosForSelection = walletUtxos.filter((u) => !inputRefs.has(refKey(u)));
	if (walletUtxosForSelection.length > 0) {
		txBuilder.selectUtxosFrom(walletUtxosForSelection);
	}

	// Conway phase-1 collateral derived from the shared BurnAction MINT-tag
	// budget. See `deriveTotalCollateral` for the math.
	const totalCollateral = deriveTotalCollateral([exUnits], protocolParameters, lovelaceFromUtxo(collateralUtxo));
	txBuilder
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral(totalCollateral);

	// Conditional wallet "splitter" output — emitted ONLY when the burning
	// wallet has exactly one fee-eligible UTxO (the genuine trap-risk
	// floor). See `batch-helpers.ts WALLET_SPLITTER_LOVELACE` for full
	// rationale; the burn caller already filters collateral + assetUtxos
	// upstream so `walletUtxosForSelection.length` is the fee-eligible
	// count directly.
	if (walletUtxosForSelection.length === 1) {
		txBuilder.txOut(walletAddress, [{ unit: 'lovelace', quantity: WALLET_SPLITTER_LOVELACE.toString() }]);
	}

	logger.debug('Built V2 batch deregister tx', {
		policyId,
		assetCount: items.length,
		exUnits,
	});

	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.setNetwork(network)
		.metadataValue(SERVICE_CONSTANTS.METADATA.masumiLabel, {
			msg: ['Masumi', 'DeregisterAgent'],
		})
		.changeAddress(walletAddress)
		.complete();
}

/**
 * Build a single tx that atomically updates N V2 registry NFTs: for every item
 * it burns the current asset and mints its version-bumped replacement, all under
 * one shared `UpdateAction` redeemer (alt=1). The V2 mint validator checks
 * `minted_count == burned_count` and pairs every burn to a mint by
 * `asset_name_continues_with_next_version` (same nonce+root, version+1), so the
 * whole bucket validates atomically — see smart-contracts/registry-v2/validators/mint.ak.
 *
 * Every `assetUtxo` MUST be a tx input (spending it burns the old asset and
 * authorizes the update). Two-pass `evaluateTx` is built in: pass 1 attaches
 * default exUnits, pass 2 uses the chain-computed MINT budget.
 */
export async function generateRegistryBatchUpdateTransactionAutomaticFees(
	blockchainProvider: BlockfrostProvider,
	network: Network,
	script: { version: LanguageVersion; code: string },
	walletAddress: string,
	policyId: string,
	items: BatchRegistryUpdateItem[],
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	rpcApiKey?: string,
): Promise<string> {
	if (items.length === 0) {
		throw new Error('no items in batch');
	}
	// Every asset name in the tx — old (burned) and new (minted) — must be
	// distinct: Mesh queues mint legs by name and the validator pairs each burn
	// to exactly one version-continuing mint.
	assertDistinctAssetNames(items.flatMap((item) => [item.oldAssetName, item.newAssetName]));
	// Old asset UTxOs MUST be inputs (to burn); collateral must not overlap them
	// (Conway phase-1 forbids collateral ∩ inputs).
	assertCollateralNotInInputs(
		collateralUtxo,
		items.map((item) => item.assetUtxo),
	);
	for (const item of items) {
		const unit = policyId + item.oldAssetName;
		const hasAsset = item.assetUtxo.output.amount.some((asset) => asset.unit === unit && BigInt(asset.quantity) >= 1n);
		if (!hasAsset) {
			throw new Error(`assetUtxo ${refKey(item.assetUtxo)} does not contain asset ${unit}`);
		}
	}

	if (rpcApiKey) {
		await syncMeshCostModelsFromChainV2(rpcApiKey);
	}

	const evaluationTx = await buildBatchUpdateTx(
		blockchainProvider,
		network,
		script,
		walletAddress,
		policyId,
		items,
		collateralUtxo,
		walletUtxos,
		DEFAULT_EX_UNITS_FALLBACK,
		rpcApiKey,
	);

	const evaluated = (await blockchainProvider.evaluateTx(evaluationTx)) as EvalAction[];
	const mintBudget = findMintExUnits(evaluated);
	if (mintBudget == null) {
		throw new Error(`evaluateTx did not return a MINT budget for batch update; got ${evaluated.length} action(s)`);
	}

	return await buildBatchUpdateTx(
		blockchainProvider,
		network,
		script,
		walletAddress,
		policyId,
		items,
		collateralUtxo,
		walletUtxos,
		mintBudget,
		rpcApiKey,
	);
}

async function buildBatchUpdateTx(
	blockchainProvider: IFetcher,
	network: Network,
	script: { version: LanguageVersion; code: string },
	walletAddress: string,
	policyId: string,
	items: BatchRegistryUpdateItem[],
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	exUnits: ExUnits,
	rpcApiKey?: string,
): Promise<string> {
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));

	const txBuilder = new MeshTxBuilder({ fetcher: blockchainProvider });
	txBuilder.protocolParams(protocolParameters);
	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

	// Bring every old-asset UTxO into the tx FIRST so the wallet holds the assets
	// to burn. De-dupe against walletUtxos (the asset UTxO is usually already in
	// the wallet set).
	const inputRefs = new Set<string>();
	for (const item of items) {
		const key = refKey(item.assetUtxo);
		if (inputRefs.has(key)) continue;
		inputRefs.add(key);
		txBuilder.txIn(item.assetUtxo.input.txHash, item.assetUtxo.input.outputIndex);
	}

	// Per-item legs: burn old (-1) + mint new (+1), both under one shared
	// `UpdateAction` redeemer. Script + redeemer must attach to EACH leg (Mesh's
	// `mint()` flushes the previous leg via `queueMint()`, which requires that
	// leg's `scriptSource` already set — see the mint/burn builders above). Mesh
	// merges every same-policy leg into one bucket with the shared redeemer, so
	// the validator sees a single atomic `UpdateAction`.
	for (const item of items) {
		txBuilder
			.mintPlutusScript(script.version)
			.mint('-1', policyId, item.oldAssetName)
			.mintingScript(script.code)
			.mintRedeemerValue({ alternative: V2_UPDATE_REDEEMER_ALTERNATIVE, fields: [] }, 'Mesh', exUnits)
			.mintPlutusScript(script.version)
			.mint(SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity, policyId, item.newAssetName)
			.mintingScript(script.code)
			.mintRedeemerValue({ alternative: V2_UPDATE_REDEEMER_ALTERNATIVE, fields: [] }, 'Mesh', exUnits);
	}

	// Combined CIP-25 metadata for the NEW asset names, one `721` block.
	const perAssetMetadata: Record<string, RegistryMetadata> = {};
	for (const item of items) {
		perAssetMetadata[item.newAssetName] = item.metadata;
	}
	txBuilder.metadataValue(SERVICE_CONSTANTS.METADATA.nftLabel, {
		[policyId]: perAssetMetadata,
		version: '1',
	});

	// Hand the remaining wallet UTxOs to Mesh's coin selector for fees/change;
	// exclude the asset inputs (already added) and the collateral (mesh does not
	// auto-exclude collateral from selection — overlap fails Conway phase-1).
	inputRefs.add(refKey(collateralUtxo));
	const walletUtxosForSelection = walletUtxos.filter((u) => !inputRefs.has(refKey(u)));
	if (walletUtxosForSelection.length > 0) {
		txBuilder.selectUtxosFrom(walletUtxosForSelection);
	}

	const totalCollateral = deriveTotalCollateral([exUnits], protocolParameters, lovelaceFromUtxo(collateralUtxo));
	txBuilder
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral(totalCollateral);

	// One recipient output per updated asset: the NEW asset + its funding lovelace.
	for (const item of items) {
		txBuilder.txOut(item.recipientWalletAddress, [
			{
				unit: policyId + item.newAssetName,
				quantity: SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity,
			},
			{
				unit: SERVICE_CONSTANTS.CARDANO.NATIVE_TOKEN,
				quantity: item.fundingLovelace,
			},
		]);
	}

	if (walletUtxosForSelection.length === 1) {
		txBuilder.txOut(walletAddress, [{ unit: 'lovelace', quantity: WALLET_SPLITTER_LOVELACE.toString() }]);
	}

	logger.debug('Built V2 batch update tx', {
		policyId,
		assetCount: items.length,
		exUnits,
	});

	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.setNetwork(network)
		.metadataValue(SERVICE_CONSTANTS.METADATA.masumiLabel, {
			msg: ['Masumi', 'UpdateAgent'],
		})
		.changeAddress(walletAddress)
		.complete();
}
