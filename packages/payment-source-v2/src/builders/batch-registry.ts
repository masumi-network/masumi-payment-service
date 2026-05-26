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
import { deriveTotalCollateral, WALLET_SPLITTER_LOVELACE } from './batch-helpers';

// V2 mint contract `Action` enum: MintAction=0, UpdateAction=1, BurnAction=2.
// See smart-contracts/registry-v2/validators/mint.ak.
const V2_MINT_REDEEMER_ALTERNATIVE = 0;
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

	// Mint context: select the policy script ONCE, then append every asset.
	// `mintingScript` + `mintRedeemerValue` apply to the whole policy bucket
	// — the V2 validator validates the bucket atomically against `MintAction`.
	txBuilder.mintPlutusScript(script.version);
	for (const item of items) {
		txBuilder.mint(SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity, policyId, item.assetName);
	}
	txBuilder
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: V2_MINT_REDEEMER_ALTERNATIVE, fields: [] }, 'Mesh', exUnits);

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
	const walletUtxosForSelection = walletUtxos.filter((u) => !inputRefs.has(refKey(u)));
	if (walletUtxosForSelection.length > 0) {
		txBuilder.selectUtxosFrom(walletUtxosForSelection);
	}

	// Conway phase-1 collateral derived from the single shared MINT redeemer
	// budget. `exUnits` is either the default (first pass) or the chain-
	// evaluated MINT budget from `evaluateTx` (subsequent calls). See
	// `deriveTotalCollateral` for the math.
	const totalCollateral = deriveTotalCollateral([exUnits], protocolParameters);
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
	// wallet is at the 2-UTxO floor (collateral + at most one other input).
	// Healthy wallets (3+ UTxOs) skip the splitter so batch txs stay tight.
	// See `batch-helpers.ts WALLET_SPLITTER_LOVELACE` for full rationale.
	if (walletUtxosForSelection.length <= 2) {
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

	txBuilder.mintPlutusScript(script.version);
	for (const item of items) {
		txBuilder.mint('-1', policyId, item.assetName);
	}
	txBuilder
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: V2_BURN_REDEEMER_ALTERNATIVE, fields: [] }, 'Mesh', exUnits);

	// Hand remaining wallet UTxOs to Mesh's coin selector instead of force-adding
	// every one. Anything already declared as a `.txIn` above (via inputRefs) is
	// excluded so the selector doesn't try to add a duplicate. Same rationale as
	// the mint builder above — avoid bloated tx size and double-spend overlap
	// with collateral on fragmented wallets.
	const walletUtxosForSelection = walletUtxos.filter((u) => !inputRefs.has(refKey(u)));
	if (walletUtxosForSelection.length > 0) {
		txBuilder.selectUtxosFrom(walletUtxosForSelection);
	}

	// Conway phase-1 collateral derived from the shared BurnAction MINT-tag
	// budget. See `deriveTotalCollateral` for the math.
	const totalCollateral = deriveTotalCollateral([exUnits], protocolParameters);
	txBuilder
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral(totalCollateral);

	// Conditional wallet "splitter" output — emitted ONLY when the burning
	// wallet is at the 2-UTxO floor. Healthy wallets skip. See
	// `batch-helpers.ts WALLET_SPLITTER_LOVELACE` for full rationale.
	if (walletUtxosForSelection.length <= 2) {
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
