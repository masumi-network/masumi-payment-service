// Mesh SDK pinning: this file lives in the V2 package and MUST resolve to the
// V2 mesh line (`@meshsdk/core@1.9.0-beta.102` / `@meshsdk/core-cst@1.9.0-beta.102`).
// The derived script-data-hash and CBOR encoding depend on the exact serializer
// behavior of these versions. Do not unify with the V1 pin. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
//
// This is a faithful port of the single-item builders in
// `src/utils/generator/transaction-generator/index.ts` (which is V1-mesh-pinned).
// V2 single-item seller/buyer actions (submit-result, collection,
// authorize-refund, authorize-withdrawal, request-refund, collect-refund) MUST
// build through THIS module so the redeemer CBOR and Plutus cost-model bundle
// match the V2 contracts. Routing them through the V1 generator (beta.96)
// produces a script-data-hash the ledger rejects with `PPViewHashesDontMatch`.
// The batch builders (batch-interaction.ts) are already V2-pinned; this covers
// the single-item fallback paths the batch services drop down to.
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
import { getCachedChainProtocolParameters } from '@/utils/mesh-cost-model-sync';
import { syncMeshCostModelsFromChainV2 } from '../utils/mesh-cost-model-sync';
import { generateRedeemerData } from './redeemer-data';

// Mirrors `FALLBACK_COINS_PER_UTXO_SIZE` in @masumi/payment-core/config; kept
// inline for the same test-mock reason documented in batch-interaction.ts (the
// V2 package is re-exported from its root and some specs mock the config with a
// partial surface). Update both in lockstep if upstream changes the value.
const FALLBACK_COINS_PER_UTXO_SIZE = 4310;

// Interaction redeemers built by the V2 single-item path. `CancelRefund` is
// intentionally excluded — the V2 validator has no such action (see
// redeemer-data.ts); V1 callers keep using the root generator.
type V2SingleInteractionType = 'AuthorizeRefund' | 'AuthorizeWithdrawal' | 'RequestRefund' | 'SubmitResult';

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

export async function generateMasumiSmartContractInteractionTransactionAutomaticFees(
	type: V2SingleInteractionType,
	blockchainProvider: BlockfrostProvider,
	network: Network,
	script: {
		version: LanguageVersion;
		code: string;
	},
	walletAddress: string,
	smartContractUtxo: UTxO,
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	newInlineDatum: Data,
	invalidBefore: number,
	invalidAfter: number,
	rpcApiKey?: string,
	// Optional V2 single-item fallback support: when set, emit an explicit
	// self-send "splitter" output of this many lovelace back to walletAddress
	// before the change output. Raises the post-tx wallet UTxO floor from 2
	// (collateral + change) to 3 (collateral + change + splitter), matching
	// the V2 batch-builder splitter semantics. See
	// `packages/payment-source-v2/src/builders/batch-helpers.ts WALLET_SPLITTER_LOVELACE`.
	walletSplitterLovelace?: bigint,
	// Hydra L2: when set, the tx is built and submitted against a Hydra head
	// instead of L1. The provider is the head's IFetcher (UTxOs come from the
	// head snapshot). On L2 we skip Blockfrost fee evaluation (the head uses
	// zero/standard fees) and tag the MeshTxBuilder with `isHydra`. The actual
	// build still happens on the V2 mesh line (beta.102) so the script-data-hash
	// matches the V2 contract. `IFetcher` is byte-identical across the V1/V2 mesh
	// lines (verified), so a root-built HydraProvider is structurally accepted.
	hydraProvider?: IFetcher,
) {
	const isL2 = hydraProvider != null;
	const provider = hydraProvider ?? blockchainProvider;

	if (rpcApiKey) {
		// Mesh hashes the script_data against its bundled
		// `DEFAULT_V*_COST_MODEL_LIST` arrays; if those drift from on-chain the
		// ledger rejects with `PPViewHashesDontMatch`. Sync the V2 mesh line's
		// arrays from chain before each build. The helper is memoized 5min.
		await syncMeshCostModelsFromChainV2(rpcApiKey);
	}
	let coinsPerUtxoSize: number = FALLBACK_COINS_PER_UTXO_SIZE;
	try {
		const protocolParams = await blockchainProvider.fetchProtocolParameters();
		if (protocolParams.coinsPerUtxoSize != null) {
			coinsPerUtxoSize = protocolParams.coinsPerUtxoSize;
		}
		logger.debug('Fetched protocol parameters for min-UTXO calculation', {
			coinsPerUtxoSize,
			type,
		});
	} catch (error) {
		logger.warn('Failed to fetch protocol parameters, using fallback value for min-UTXO calculation', {
			fallbackCoinsPerUtxoSize: coinsPerUtxoSize,
			error: error instanceof Error ? error.message : String(error),
			type,
		});
	}

	// L2 path: a Hydra head has no Blockfrost evaluator, so skip the fee-eval
	// round-trip and build directly with default exUnits + isHydra.
	if (isL2) {
		return await generateMasumiSmartContractInteractionTransactionCustomFee(
			type,
			provider,
			network,
			script,
			walletAddress,
			smartContractUtxo,
			collateralUtxo,
			walletUtxos,
			newInlineDatum,
			invalidBefore,
			invalidAfter,
			undefined,
			coinsPerUtxoSize,
			undefined,
			undefined,
			true,
		);
	}

	const evaluationTx = await generateMasumiSmartContractInteractionTransactionCustomFee(
		type,
		blockchainProvider,
		network,
		script,
		walletAddress,
		smartContractUtxo,
		collateralUtxo,
		walletUtxos,
		newInlineDatum,
		invalidBefore,
		invalidAfter,
		undefined,
		coinsPerUtxoSize,
		rpcApiKey,
		walletSplitterLovelace,
	);

	const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
		budget: { mem: number; steps: number };
	}>;

	return await generateMasumiSmartContractInteractionTransactionCustomFee(
		type,
		blockchainProvider,
		network,
		script,
		walletAddress,
		smartContractUtxo,
		collateralUtxo,
		walletUtxos,
		newInlineDatum,
		invalidBefore,
		invalidAfter,
		estimatedFee[0].budget,
		coinsPerUtxoSize,
		rpcApiKey,
		walletSplitterLovelace,
	);
}

async function generateMasumiSmartContractInteractionTransactionCustomFee(
	type: V2SingleInteractionType,
	blockchainProvider: IFetcher,
	network: Network,
	script: {
		version: LanguageVersion;
		code: string;
	},
	walletAddress: string,
	smartContractUtxo: UTxO,
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	newInlineDatum: Data,
	invalidBefore: number,
	invalidAfter: number,
	exUnits: {
		mem: number;
		steps: number;
	} = {
		mem: 7e6,
		steps: 3e9,
	},

	coinsPerUtxoSize: number = FALLBACK_COINS_PER_UTXO_SIZE,
	rpcApiKey?: string,
	walletSplitterLovelace?: bigint,
	// Hydra L2: tag the builder so mesh skips L1-only collateral/fee handling.
	isHydra = false,
) {
	// Pull live chain protocol params (incl. cost models) so the computed
	// script_data_hash matches what the ledger expects. The outer Automatic
	// builder already called syncMeshCostModelsFromChainV2 which caches the
	// mesh-format Protocol; reuse it to skip a duplicate
	// `/epochs/latest/parameters` call. Fall back to a live fetch on cache
	// miss (e.g. very first tx of the process). The cached Protocol carries no
	// cost-model fields (mesh uses its bundled, now-V2-synced arrays), so
	// sharing the cache across mesh lines is safe.
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
		isHydra,
	});
	txBuilder.protocolParams(protocolParameters);
	const redeemerData = generateRedeemerData(type);
	const smartContractAddress: unknown = resolvePlutusScriptAddress(
		script,
		convertNetworkToId(convertMeshNetworkToPrismaNetwork(network)),
	);
	if (typeof smartContractAddress !== 'string') {
		throw new TypeError(`Expected resolvePlutusScriptAddress to return a string, got: ${typeof smartContractAddress}`);
	}

	const nativeTokenCount = getNativeTokenCount(smartContractUtxo.output.amount);
	const minUtxoResult = calculateMinUtxo({
		datum: newInlineDatum,
		nativeTokenCount,
		coinsPerUtxoSize,
		includeBuffers: true,
	});

	const currentLovelace = getLovelaceFromAmounts(smartContractUtxo.output.amount);
	const topUpAmount = calculateTopUpAmount(currentLovelace, minUtxoResult.minUtxoLovelace);

	const outputAmount: Asset[] = [...smartContractUtxo.output.amount];

	if (topUpAmount > 0n) {
		logger.info('Applying min-UTXO top-up for smart contract interaction', {
			type,
			currentLovelace: currentLovelace.toString(),
			requiredMinUtxo: minUtxoResult.minUtxoLovelace.toString(),
			topUpAmount: topUpAmount.toString(),
			nativeTokenCount,
			coinsPerUtxoSize,
			txHash: smartContractUtxo.input.txHash,
			note: 'UTxO may have been created with different protocol parameters or underfunded externally',
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

	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);
	txBuilder
		.spendingPlutusScript(script.version)
		.txIn(
			smartContractUtxo.input.txHash,
			smartContractUtxo.input.outputIndex,
			smartContractUtxo.output.amount,
			smartContractUtxo.output.address,
			smartContractUtxo.output.scriptRef ? smartContractUtxo.output.scriptRef.length / 2 : 0,
		)
		.txInScript(script.code) // ,script.version)
		.txInRedeemerValue(redeemerData, 'Mesh', exUnits)
		.txInInlineDatumPresent()
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral('3000000')
		.txOut(smartContractAddress, outputAmount)
		.txOutInlineDatumValue(newInlineDatum);

	for (const utxo of walletUtxos) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}

	// Optional self-send splitter for V2 single-item callers. See docstring
	// on the public AutomaticFees entry point. Emitted BEFORE
	// `.changeAddress(...)` so mesh's coin selection accounts for it as a
	// required output.
	if (walletSplitterLovelace != null) {
		txBuilder.txOut(walletAddress, [{ unit: 'lovelace', quantity: walletSplitterLovelace.toString() }]);
	}

	return await txBuilder
		.changeAddress(walletAddress)
		.invalidBefore(invalidBefore)
		.invalidHereafter(invalidAfter)
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.setNetwork(network)
		.metadataValue(674, {
			msg: ['Masumi', type],
		})
		.complete();
}

export async function generateMasumiSmartContractWithdrawTransactionAutomaticFees(
	type: 'CollectCompleted' | 'CollectRefund',
	blockchainProvider: BlockfrostProvider,
	network: Network,
	script: {
		version: LanguageVersion;
		code: string;
	},
	walletAddress: string,
	smartContractUtxo: UTxO,
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	collection: {
		collectAssets: Asset[];
		collectionAddress: string;
	},
	fee: {
		feeAssets: Asset[];
		feeAddress: string;
		txHash: string;
		outputIndex: number;
	} | null,
	collateralReturn: {
		lovelace: bigint;
		address: string;
		txHash: string;
		outputIndex: number;
	} | null,
	invalidBefore: number,
	invalidAfter: number,
	// V2 only: tag the main collection output with `OutputReference == own_ref`
	// so the Aiken `outputs_with_reference_tag` filter matches it. Required when
	// the on-chain datum has `seller_return_address`/`buyer_return_address` set
	// (otherwise vested_pay.ak rejects the withdraw with value_returned == 0).
	tagMainOutputAsOwnRef: boolean = false,
	rpcApiKey?: string,
	// Optional V2 single-item fallback support — see equivalent param on
	// `generateMasumiSmartContractInteractionTransactionAutomaticFees`.
	walletSplitterLovelace?: bigint,
	// Hydra L2 — see equivalent param on the interaction builder above.
	hydraProvider?: IFetcher,
) {
	const isL2 = hydraProvider != null;

	if (rpcApiKey) {
		// See cost-model sync comment in the interaction builder above.
		await syncMeshCostModelsFromChainV2(rpcApiKey);
	}

	// L2 path: no Blockfrost evaluator on a Hydra head — build directly with
	// default exUnits + isHydra (see interaction builder).
	if (isL2) {
		return await generateMasumiSmartContractWithdrawTransactionCustomFee(
			type,
			hydraProvider,
			network,
			script,
			walletAddress,
			smartContractUtxo,
			collateralUtxo,
			walletUtxos,
			collection,
			fee,
			collateralReturn,
			invalidBefore,
			invalidAfter,
			undefined,
			tagMainOutputAsOwnRef,
			undefined,
			undefined,
			true,
		);
	}

	const evaluationTx = await generateMasumiSmartContractWithdrawTransactionCustomFee(
		type,
		blockchainProvider,
		network,
		script,
		walletAddress,
		smartContractUtxo,
		collateralUtxo,
		walletUtxos,
		collection,
		fee,
		collateralReturn,
		invalidBefore,
		invalidAfter,
		undefined,
		tagMainOutputAsOwnRef,
		rpcApiKey,
		walletSplitterLovelace,
	);

	const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
		budget: { mem: number; steps: number };
	}>;

	return await generateMasumiSmartContractWithdrawTransactionCustomFee(
		type,
		blockchainProvider,
		network,
		script,
		walletAddress,
		smartContractUtxo,
		collateralUtxo,
		walletUtxos,
		collection,
		fee,
		collateralReturn,
		invalidBefore,
		invalidAfter,
		estimatedFee[0].budget,
		tagMainOutputAsOwnRef,
		rpcApiKey,
		walletSplitterLovelace,
	);
}

async function generateMasumiSmartContractWithdrawTransactionCustomFee(
	type: 'CollectCompleted' | 'CollectRefund',
	blockchainProvider: IFetcher,
	network: Network,
	script: {
		version: LanguageVersion;
		code: string;
	},
	walletAddress: string,
	smartContractUtxo: UTxO,
	collateralUtxo: UTxO,
	walletUtxos: UTxO[],
	collection: {
		collectAssets: Asset[];
		collectionAddress: string;
	},
	fee: {
		feeAssets: Asset[];
		feeAddress: string;
		txHash: string;
		outputIndex: number;
	} | null,
	collateralReturn: {
		lovelace: bigint;
		address: string;
		txHash: string;
		outputIndex: number;
	} | null,
	invalidBefore: number,
	invalidAfter: number,
	exUnits: {
		mem: number;
		steps: number;
	} = {
		mem: 7e6,
		steps: 3e9,
	},
	tagMainOutputAsOwnRef: boolean = false,
	rpcApiKey?: string,
	walletSplitterLovelace?: bigint,
	// Hydra L2: tag the builder so mesh skips L1-only collateral/fee handling.
	isHydra = false,
) {
	// See protocolParams comment in the interaction builder above. Reuse the
	// cached chain params populated by syncMeshCostModelsFromChainV2 to avoid a
	// second `/epochs/latest/parameters` roundtrip per tx build.
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
		isHydra,
	});
	txBuilder.protocolParams(protocolParameters);
	const redeemerData = generateRedeemerData(type);

	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);
	txBuilder
		.spendingPlutusScript(script.version)
		.txIn(
			smartContractUtxo.input.txHash,
			smartContractUtxo.input.outputIndex,
			smartContractUtxo.output.amount,
			smartContractUtxo.output.address,
			smartContractUtxo.output.scriptRef ? smartContractUtxo.output.scriptRef.length / 2 : 0,
		)
		.txInScript(script.code) // ,script.version)
		.txInRedeemerValue(redeemerData, 'Mesh', exUnits)
		.txInInlineDatumPresent()
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral('3000000')
		.txOut(collection.collectionAddress, collection.collectAssets);

	if (tagMainOutputAsOwnRef) {
		txBuilder.txOutInlineDatumValue(
			mOutputReference(smartContractUtxo.input.txHash, smartContractUtxo.input.outputIndex),
		);
	}

	for (const utxo of walletUtxos) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}

	if (fee) {
		const outputReference = mOutputReference(fee.txHash, fee.outputIndex);
		txBuilder.txOut(fee.feeAddress, fee.feeAssets).txOutInlineDatumValue(outputReference);
	}
	if (collateralReturn != null && collateralReturn.lovelace > 0n) {
		const outputReference = mOutputReference(collateralReturn.txHash, collateralReturn.outputIndex);
		txBuilder
			.txOut(collateralReturn.address, [
				{
					unit: 'lovelace',
					quantity: collateralReturn.lovelace.toString(),
				},
			])
			.txOutInlineDatumValue(outputReference);
	}

	// Optional V2 single-item splitter — see CustomFee equivalent on the
	// interaction builder for full rationale.
	if (walletSplitterLovelace != null) {
		txBuilder.txOut(walletAddress, [{ unit: 'lovelace', quantity: walletSplitterLovelace.toString() }]);
	}

	return await txBuilder
		.changeAddress(walletAddress)
		.invalidBefore(invalidBefore)
		.invalidHereafter(invalidAfter)
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.setNetwork(network)
		.metadataValue(674, {
			msg: ['Masumi', type],
		})
		.complete();
}
