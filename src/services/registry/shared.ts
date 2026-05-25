// Mesh SDK pinning: this file is in the shared `src/` tree and is implicitly
// V1-aligned because the repo root pins the V1 mesh line
// (`@meshsdk/core@1.9.0-beta.96`). It builds V1 registry mint transactions.
// V2 registry transactions are built inside `packages/payment-source-v2`,
// which pins its own newer mesh line. Do not unify; do not bump. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import { SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { blake2b } from 'ethereum-cryptography/blake2b';
import { BlockfrostProvider, IFetcher, LanguageVersion, MeshTxBuilder, Network, UTxO } from '@meshsdk/core';
import { PaymentSourceType } from '@/generated/prisma/client';
import { getCachedChainProtocolParameters, syncMeshCostModelsFromChain } from '@/utils/mesh-cost-model-sync';
import { assertNever } from '@/utils/assert-never';

export type RegistryMetadata = {
	[key: string]: string | string[] | RegistryMetadata | RegistryMetadata[] | undefined;
};

const minimumRegistryFundingLovelace = BigInt(SERVICE_CONSTANTS.SMART_CONTRACT.collateralAmount);

// V2 mint contract Action enum: MintAction=0, UpdateAction=1, BurnAction=2.
// V1 mint contract Action enum: MintAction=0, BurnAction=1.
// Map by PaymentSourceType so the same shared helper drives both.
const V1_BURN_REDEEMER_ALTERNATIVE = 1;
const V2_BURN_REDEEMER_ALTERNATIVE = 2;

export function getBurnRedeemerAlternative(paymentSourceType: PaymentSourceType): number {
	switch (paymentSourceType) {
		case PaymentSourceType.Web3CardanoV1:
			return V1_BURN_REDEEMER_ALTERNATIVE;
		case PaymentSourceType.Web3CardanoV2:
			return V2_BURN_REDEEMER_ALTERNATIVE;
		default:
			return assertNever(paymentSourceType);
	}
}

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

// V2 registry mint contract requires asset names of the exact structure:
//   [ 1 byte nonce > 0x0f | 28 bytes blake2b_224(tx_id || index_be4) | 3 bytes version 0x000000 ]
// (see smart-contracts/registry-v2/validators/mint.ak). The nonce > 0x0f guard
// keeps registry asset names out of the CIP-67/CIP-68 label-prefix range. The
// version field starts at 0 and increments by 1 on every UpdateAction.
const V2_REGISTRY_INITIAL_NONCE = '10'; // 0x10 — first byte strictly > 0x0f
const V2_REGISTRY_INITIAL_VERSION = '000000'; // 3 bytes BE, starts at 0

export function generateRegistryAssetNameV2(firstUtxo: UTxO): string {
	const txId = firstUtxo.input.txHash;
	const txIndex = firstUtxo.input.outputIndex;
	const serializedOutput = txId + txIndex.toString(16).padStart(8, '0');
	const serializedOutputUint8Array = new Uint8Array(Buffer.from(serializedOutput.toString(), 'hex'));
	// 28-byte root hash matches the contract's `blake2b_224(...)` of the same input.
	const rootHashBytes = blake2b(serializedOutputUint8Array, 28);
	const rootHashHex = Buffer.from(rootHashBytes).toString('hex');
	return V2_REGISTRY_INITIAL_NONCE + rootHashHex + V2_REGISTRY_INITIAL_VERSION;
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
	rpcApiKey?: string,
) {
	if (rpcApiKey) {
		// `protocolParams(...)` below does NOT carry cost models; mesh-sdk
		// hashes script_data against its BUNDLED cost-model arrays. Patch them
		// from chain or risk `PPViewHashesDontMatch` after any cost-model vote.
		// Helper is memoized 5 min so this is cheap to call before each build.
		await syncMeshCostModelsFromChain(rpcApiKey);
	}
	// Fetch CURRENT chain protocol parameters (including the live Plutus cost
	// models) and feed them into MeshTxBuilder. Without this, MeshTxBuilder
	// falls back to its bundled default cost models, which can lag behind the
	// chain after a hard fork or PParam vote. When that happens the
	// script_data_hash computed for the transaction body does not match what
	// the ledger recomputes from the actual on-chain cost models, and the
	// submission is rejected with `ConwayUtxowFailure
	// (PPViewHashesDontMatch ...)`. Symptom in CI: V1 RegistrationFailed with
	// `TxSubmitFail` / `TxValidationErrorInCardanoMode` carrying a
	// PPViewHashesDontMatch mismatch where `supplied` and `expected` are both
	// stable across runs (because mesh's bundled models are deterministic).
	// `syncMeshCostModelsFromChain` (above, when `rpcApiKey` is supplied) ALSO
	// caches the mesh-format Protocol object so we don't repeat
	// `/epochs/latest/parameters` here. Fall back to a live fetch if the cache
	// is cold (first tx of the process lifetime).
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
	});
	txBuilder.protocolParams(protocolParameters);
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
	// V1 burn=alt 1; V2 burn=alt 2 (V2 reserves alt 1 for UpdateAction).
	// Resolved via getBurnRedeemerAlternative(paymentSourceType).
	burnRedeemerAlternative: number = V1_BURN_REDEEMER_ALTERNATIVE,
	rpcApiKey?: string,
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
		undefined,
		burnRedeemerAlternative,
		rpcApiKey,
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
		burnRedeemerAlternative,
		rpcApiKey,
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
	burnRedeemerAlternative: number = V1_BURN_REDEEMER_ALTERNATIVE,
	rpcApiKey?: string,
) {
	if (rpcApiKey) {
		// See cost-model sync comment in generateRegistryMintTransaction above.
		await syncMeshCostModelsFromChain(rpcApiKey);
	}
	// Reuse the cached mesh-format chain params populated by the cost-model
	// sync (see generateRegistryMintTransaction). Fall back to a live fetch on
	// cache miss.
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
	});
	txBuilder.protocolParams(protocolParameters);
	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

	txBuilder
		.txIn(assetUtxo.input.txHash, assetUtxo.input.outputIndex)
		.mintPlutusScript(script.version)
		.mint('-1', policyId, assetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: burnRedeemerAlternative, fields: [] }, 'Mesh', exUnits)
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
