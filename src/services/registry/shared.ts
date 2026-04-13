import { SERVICE_CONSTANTS } from '@/utils/config';
import { blake2b } from 'ethereum-cryptography/blake2b';
import { BlockfrostProvider, IFetcher, LanguageVersion, MeshTxBuilder, Network, UTxO } from '@meshsdk/core';

export type RegistryMetadata = {
	[key: string]: string | string[] | RegistryMetadata | RegistryMetadata[] | undefined;
};

const minimumRegistryFundingLovelace = BigInt(SERVICE_CONSTANTS.SMART_CONTRACT.collateralAmount);

export function normalizeRequestedRegistryFundingLovelace(sendFundingLovelace?: string): bigint | undefined {
	if (sendFundingLovelace == null) {
		return undefined;
	}

	const requestedFundingLovelace = BigInt(sendFundingLovelace);
	return requestedFundingLovelace > minimumRegistryFundingLovelace
		? requestedFundingLovelace
		: minimumRegistryFundingLovelace;
}

export function generateRegistryAssetName(firstUtxo: UTxO): string {
	const txId = firstUtxo.input.txHash;
	const txIndex = firstUtxo.input.outputIndex;
	const serializedOutput = txId + txIndex.toString(16).padStart(8, '0');

	const serializedOutputUint8Array = new Uint8Array(Buffer.from(serializedOutput.toString(), 'hex'));
	const blake2b256 = blake2b(serializedOutputUint8Array, 32);
	return Buffer.from(blake2b256).toString('hex');
}

export function resolveRegistryRecipientWalletAddress(request: {
	SmartContractWallet: { walletAddress: string };
	RecipientWallet: { walletAddress: string } | null;
}) {
	return request.RecipientWallet?.walletAddress ?? request.SmartContractWallet.walletAddress;
}

export function resolveRegistryFundingLovelace(request: { sendFundingLovelace: bigint | null }) {
	if (request.sendFundingLovelace == null || request.sendFundingLovelace < minimumRegistryFundingLovelace) {
		return minimumRegistryFundingLovelace.toString();
	}

	return request.sendFundingLovelace.toString();
}

export async function generateRegistryMintTransaction(
	blockchainProvider: IFetcher,
	network: Network,
	script: {
		version: LanguageVersion;
		code: string;
	},
	mintingWalletAddress: string,
	recipientWalletAddress: string,
	fundingLovelace: string,
	policyId: string,
	assetName: string,
	firstUtxo: UTxO,
	collateralUtxo: UTxO,
	utxos: UTxO[],
	metadata: RegistryMetadata,
	exUnits: {
		mem: number;
		steps: number;
	} = SERVICE_CONSTANTS.SMART_CONTRACT.defaultExUnits,
) {
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
	});
	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(mintingWalletAddress);

	txBuilder
		.txIn(firstUtxo.input.txHash, firstUtxo.input.outputIndex)
		.mintPlutusScript(script.version)
		.mint('1', policyId, assetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: 0, fields: [] }, 'Mesh', exUnits)
		.metadataValue(SERVICE_CONSTANTS.METADATA.nftLabel, {
			[policyId]: {
				[assetName]: metadata,
			},
			version: '1',
		})
		.txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral(SERVICE_CONSTANTS.SMART_CONTRACT.collateralAmount)
		.txOut(recipientWalletAddress, [
			{
				unit: policyId + assetName,
				quantity: SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity,
			},
			{
				unit: SERVICE_CONSTANTS.CARDANO.NATIVE_TOKEN,
				quantity: fundingLovelace,
			},
		]);
	for (const utxo of utxos) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
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

export function findRegistryTokenUtxo(utxos: UTxO[], agentIdentifier: string): UTxO {
	const tokenUtxo = utxos.find(
		(utxo) => utxo.output.amount.length > 1 && utxo.output.amount.some((asset) => asset.unit == agentIdentifier),
	);
	if (!tokenUtxo) {
		throw new Error('No token UTXO found');
	}

	return tokenUtxo;
}

export function resolveRegistryDeregistrationWallet<
	T extends { id: string; Secret: { encryptedMnemonic: string } },
>(request: { SmartContractWallet: T; DeregistrationHotWallet: T | null }) {
	return request.DeregistrationHotWallet ?? request.SmartContractWallet;
}

export async function generateRegistryDeregisterTransactionAutomaticFees(
	blockchainProvider: BlockfrostProvider,
	network: Network,
	script: {
		version: LanguageVersion;
		code: string;
	},
	walletAddress: string,
	policyId: string,
	assetName: string,
	assetUtxo: UTxO,
	collateralUtxo: UTxO,
	utxos: UTxO[],
) {
	const evaluationTx = await generateRegistryDeregisterTransaction(
		blockchainProvider,
		network,
		script,
		walletAddress,
		policyId,
		assetName,
		assetUtxo,
		collateralUtxo,
		utxos,
	);
	const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
		budget: { mem: number; steps: number };
	}>;

	return await generateRegistryDeregisterTransaction(
		blockchainProvider,
		network,
		script,
		walletAddress,
		policyId,
		assetName,
		assetUtxo,
		collateralUtxo,
		utxos,
		estimatedFee[0].budget,
	);
}

async function generateRegistryDeregisterTransaction(
	blockchainProvider: IFetcher,
	network: Network,
	script: {
		version: LanguageVersion;
		code: string;
	},
	walletAddress: string,
	policyId: string,
	assetName: string,
	assetUtxo: UTxO,
	collateralUtxo: UTxO,
	utxos: UTxO[],
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
	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

	txBuilder
		.txIn(assetUtxo.input.txHash, assetUtxo.input.outputIndex)
		.mintPlutusScript(script.version)
		.mint('-1', policyId, assetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: 1, fields: [] }, 'Mesh', exUnits)
		.txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral('3000000');
	for (const utxo of utxos) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}

	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.setNetwork(network)
		.metadataValue(SERVICE_CONSTANTS.METADATA.masumiLabel, { msg: ['Masumi', 'DeregisterAgent'] })
		.changeAddress(walletAddress)
		.complete();
}
