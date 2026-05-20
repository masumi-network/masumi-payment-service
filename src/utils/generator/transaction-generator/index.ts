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
) {
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
	);
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
) {
	// Pull live chain protocol params (incl. cost models) so the computed
	// script_data_hash matches what the ledger expects. Without this, mesh
	// uses its bundled defaults and submissions fail with
	// `PPViewHashesDontMatch` after a hard fork or PParam vote. See
	// generateRegistryMintTransaction in src/services/registry/shared.ts.
	const protocolParameters = await blockchainProvider.fetchProtocolParameters(0);
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

	for (const utxo of walletUtxos) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
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
) {
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
) {
	// See protocolParams comment in the first builder in this file.
	const protocolParameters = await blockchainProvider.fetchProtocolParameters(0);
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
