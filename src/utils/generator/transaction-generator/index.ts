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
	type: 'AuthorizeRefund' | 'CancelRefund' | 'RequestRefund' | 'SubmitResult',
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
	);
}

export async function generateMasumiSmartContractInteractionTransactionCustomFee(
	type: 'AuthorizeRefund' | 'CancelRefund' | 'RequestRefund' | 'SubmitResult',
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
) {
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
	});
	const redeemerData = generateRedeemerData(type);
	const smartContractAddress: unknown = resolvePlutusScriptAddress(
		script,
		convertNetworkToId(convertMeshNetworkToPrismaNetwork(network)),
	);
	if (typeof smartContractAddress !== 'string') {
		throw new TypeError(`Expected resolvePlutusScriptAddress to return a string, got: ${typeof smartContractAddress}`);
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
		.txOut(smartContractAddress, smartContractUtxo.output.amount)
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
	type: 'AuthorizeRefund' | 'CancelRefund' | 'RequestRefund' | 'SubmitResult' | 'CollectCompleted' | 'CollectRefund',
) {
	switch (type) {
		case 'AuthorizeRefund':
			return {
				alternative: 6,
				fields: [],
			};
		case 'CancelRefund':
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

export async function generateMasumiSmartContractWithdrawTransactionCustomFee(
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
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
	});
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
