import {
	Asset,
	BlockfrostProvider,
	Data,
	IFetcher,
	LanguageVersion,
	MeshTxBuilder,
	mOutputReference,
	Network,
	UTxO,
} from '@meshsdk/core';
import { resolvePlutusScriptAddress } from '@meshsdk/core-cst';
import { convertNetworkToId } from '@/utils/converter/network-convert';
import { Network as PrismaNetwork } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';
import { calculateMinUtxo, getLovelaceFromAmounts, getNativeTokenCount, calculateTopUpAmount } from '@/utils/min-utxo';
import { CONSTANTS } from '@masumi/payment-core/config';
import { getCachedChainProtocolParameters, syncMeshCostModelsFromChain } from '@/utils/mesh-cost-model-sync';
import { getSpendableWalletUtxos } from '@/utils/utxo';
import { isInsufficientBalanceBuildError } from '@masumi/payment-core/insufficient-balance-error';

/**
 * Builds with the collateral reserve held back from coin selection, and falls
 * back to offering it only if that made the transaction unbuildable.
 *
 * Two competing failure modes, both real:
 *
 *   - Mesh does NOT exclude `txInCollateral` UTxOs from `selectUtxosFrom`
 *     candidates (`getUtxosForSelection` consults `inputs`, never
 *     `collaterals`). Left available, coin selection spends the reserve — the
 *     tx confirms, but the wallet has no collateral for the NEXT escrow action.
 *
 *   - Holding it back can leave nothing large enough to cover outputs, fee and
 *     minimum change — e.g. a wallet whose only pure-ADA UTxO above the 5 ADA
 *     collateral floor is the one now reserved. That build fails outright,
 *     which is strictly worse than consuming the reserve.
 *
 * A static filter can only pick one. Preferring exclusion and retrying on a
 * genuine balance failure gets both: the reserve survives whenever the wallet
 * can afford it, and a thin wallet still transacts.
 */
async function buildWithCollateralFallback(
	type: string,
	build: (allowSpendingCollateral: boolean) => Promise<string>,
): Promise<string> {
	try {
		return await build(false);
	} catch (error) {
		if (!isInsufficientBalanceBuildError(error)) {
			throw error;
		}
		logger.warn(
			'Tx could not be balanced without the collateral reserve; retrying with collateral offered to coin selection. ' +
				'The wallet will be left without a dedicated collateral UTxO — top it up.',
			{ type, error: error instanceof Error ? error.message : error },
		);
		return await build(true);
	}
}

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
	type: 'AuthorizeRefund' | 'AuthorizeWithdrawal' | 'CancelRefund' | 'RequestRefund' | 'SubmitResult',
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
	// the V2 batch-builder splitter semantics. V1 callers MUST NOT pass this —
	// V1 has no equivalent splitter convention and adding the output would
	// change tx size + fee for V1 paths. See
	// `packages/payment-source-v2/src/builders/batch-helpers.ts WALLET_SPLITTER_LOVELACE`.
	walletSplitterLovelace?: bigint,
) {
	if (rpcApiKey) {
		// `MeshTxBuilder.protocolParams(...)` accepts a Protocol object that has
		// NO cost-model fields. Mesh hashes the script_data against its bundled
		// `DEFAULT_V*_COST_MODEL_LIST` arrays; if those drift from on-chain the
		// ledger rejects with `PPViewHashesDontMatch`. Sync those arrays from
		// chain before each build. The helper is memoized 5min.
		await syncMeshCostModelsFromChain(rpcApiKey);
	}
	let coinsPerUtxoSize: number = CONSTANTS.FALLBACK_COINS_PER_UTXO_SIZE;
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

	return await buildWithCollateralFallback(type, async (allowSpendingCollateral) => {
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
			allowSpendingCollateral,
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
			allowSpendingCollateral,
		);
	});
}

async function generateMasumiSmartContractInteractionTransactionCustomFee(
	type: 'AuthorizeRefund' | 'AuthorizeWithdrawal' | 'CancelRefund' | 'RequestRefund' | 'SubmitResult',
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

	coinsPerUtxoSize: number = CONSTANTS.FALLBACK_COINS_PER_UTXO_SIZE,
	rpcApiKey?: string,
	walletSplitterLovelace?: bigint,
	allowSpendingCollateral: boolean = false,
) {
	// Pull live chain protocol params (incl. cost models) so the computed
	// script_data_hash matches what the ledger expects. Without this, mesh
	// uses its bundled defaults and submissions fail with
	// `PPViewHashesDontMatch` after a hard fork or PParam vote. See
	// generateRegistryMintTransaction in src/services/registry/shared.ts.
	// The outer Automatic builder already called syncMeshCostModelsFromChain
	// which caches the mesh-format Protocol; reuse it to skip a duplicate
	// `/epochs/latest/parameters` call. Fall back to a live fetch on cache
	// miss (e.g. very first tx of the process).
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
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

	// Keep the collateral reserve out of regular coin selection. Mesh does not
	// exclude `txInCollateral` UTxOs from `selectUtxosFrom` candidates, so it
	// otherwise spends the reserve and the next escrow action has no collateral
	// left. `getSpendableWalletUtxos` falls back to the unfiltered set when the
	// collateral is the only input available to balance with.
	txBuilder.selectUtxosFrom(
		allowSpendingCollateral ? walletUtxos : getSpendableWalletUtxos(walletUtxos, collateralUtxo),
	);

	// Optional self-send splitter for V2 single-item callers. See docstring
	// on the public AutomaticFees entry point. Emitted BEFORE
	// `.changeAddress(...)` so mesh's coin selection accounts for it as a
	// required output. V1 callers omit the param → undefined → no-op.
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

function generateRedeemerData(
	type:
		| 'AuthorizeRefund'
		| 'AuthorizeWithdrawal'
		| 'CancelRefund'
		| 'RequestRefund'
		| 'SubmitResult'
		| 'CollectCompleted'
		| 'CollectRefund',
) {
	switch (type) {
		case 'AuthorizeRefund':
			return {
				alternative: 6,
				fields: [],
			};
		// V1 cancel-refund and V2 authorize-withdrawal both occupy the same on-chain
		// redeemer alternative (2). Labels are distinct so future contract revisions can
		// split them without ambiguity in service-layer call sites.
		case 'CancelRefund':
		case 'AuthorizeWithdrawal':
			return {
				alternative: 2,
				fields: [],
			};
		case 'RequestRefund':
			return {
				alternative: 1,
				fields: [],
			};
		case 'SubmitResult':
			return {
				alternative: 5,
				fields: [],
			};
		case 'CollectCompleted':
			return {
				alternative: 0,
				fields: [],
			};
		case 'CollectRefund':
			return {
				alternative: 3,
				fields: [],
			};
	}
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
	// V1 callers MUST NOT pass.
	walletSplitterLovelace?: bigint,
) {
	if (rpcApiKey) {
		// See cost-model sync comment in the interaction builder above.
		await syncMeshCostModelsFromChain(rpcApiKey);
	}
	return await buildWithCollateralFallback(type, async (allowSpendingCollateral) => {
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
			allowSpendingCollateral,
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
			allowSpendingCollateral,
		);
	});
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
	allowSpendingCollateral: boolean = false,
) {
	// See protocolParams comment in the interaction builder above. Reuse the
	// cached chain params populated by syncMeshCostModelsFromChain to avoid a
	// second `/epochs/latest/parameters` roundtrip per tx build.
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
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

	// See the interaction builder above — the collateral reserve must stay out
	// of regular coin selection.
	txBuilder.selectUtxosFrom(
		allowSpendingCollateral ? walletUtxos : getSpendableWalletUtxos(walletUtxos, collateralUtxo),
	);

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
