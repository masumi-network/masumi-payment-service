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

// V2 registry mint redeemer: UpdateAction is alternative 1 in the on-chain
// Action enum (MintAction=0, UpdateAction=1, BurnAction=2).
const V2_UPDATE_REDEEMER_ALTERNATIVE = 1;

// V2 asset-name derivation lives in the mesh-free `./asset-name` module so it
// can be unit-tested without loading `@meshsdk/core`. Re-exported here to keep
// the existing `@/services/registry/shared` import surface stable.
export {
	bumpRegistryAssetNameVersionV2,
	unbumpRegistryAssetNameVersionV2,
	generateRegistryAssetNameV2,
	registryNonceForIndex,
	V2_REGISTRY_MAX_MINTS_PER_UTXO,
	V2_REGISTRY_NONCE_MAX,
	V2_REGISTRY_NONCE_MIN,
} from './asset-name';

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
	// Optional V2 single-item splitter support. When set, emit a self-send
	// lovelace output back to `mintingWalletAddress` before `.changeAddress`,
	// raising the post-tx wallet UTxO count from 2 (collateral + change) to 3.
	// V1 callers MUST NOT pass this (no V1 splitter convention).
	walletSplitterLovelace?: bigint,
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

	// Optional V2 single-item splitter — see param docstring above.
	if (walletSplitterLovelace != null) {
		txBuilder.txOut(mintingWalletAddress, [{ unit: 'lovelace', quantity: walletSplitterLovelace.toString() }]);
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
		// The resolved managed wallet no longer holds this registry asset. Both
		// the update (burn+remint) and deregister (burn) flows sign with this
		// wallet and need its asset UTxO as a tx input, so the on-chain tx would
		// fail regardless. Fail fast with an explicit message so operators can
		// tell "asset moved / already burned" apart from a generic build error.
		throw new Error(
			`Registry asset ${agentIdentifier} is no longer held by the resolved managed wallet; ` +
				'cannot build update/deregister transaction (asset may have been transferred or already burned)',
		);
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
	// Optional V2 single-item splitter — see equivalent param on
	// `generateRegistryMintTransaction`. V1 callers omit.
	walletSplitterLovelace?: bigint,
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
		walletSplitterLovelace,
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
		walletSplitterLovelace,
	);
}

// Build a single-item V2 registry UpdateAction transaction. The on-chain
// validator atomically pairs the burned asset with a freshly minted asset
// sharing the same nonce + root_hash but with version+1; the same
// `UpdateAction` redeemer (alternative=1) covers both the burn leg and the
// mint leg under one policy bucket. This helper performs the two-pass
// `evaluateTx` cycle and returns the unsigned tx ready for the caller to
// sign and submit.
//
// V2-only by construction — the V1 mint contract has no UpdateAction
// (Action enum is `MintAction | BurnAction`). The route layer rejects V1
// payment sources before this is ever reached.
export async function generateRegistryUpdateTransactionAutomaticFees(
	blockchainProvider: BlockfrostProvider,
	network: Network,
	script: {
		version: LanguageVersion;
		code: string;
	},
	walletAddress: string,
	recipientWalletAddress: string,
	fundingLovelace: string,
	policyId: string,
	oldAssetName: string,
	newAssetName: string,
	assetUtxo: UTxO,
	collateralUtxo: UTxO,
	utxos: UTxO[],
	metadata: RegistryMetadata,
	rpcApiKey?: string,
	walletSplitterLovelace?: bigint,
) {
	const evaluationTx = await generateRegistryUpdateTransaction(
		blockchainProvider,
		network,
		script,
		walletAddress,
		recipientWalletAddress,
		fundingLovelace,
		policyId,
		oldAssetName,
		newAssetName,
		assetUtxo,
		collateralUtxo,
		utxos,
		metadata,
		undefined,
		rpcApiKey,
		walletSplitterLovelace,
	);
	const evaluated = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
		tag?: string;
		budget: { mem: number; steps: number };
	}>;
	// One shared MINT redeemer covers the burn+mint pair under the single
	// UpdateAction policy bucket; pick the MINT entry if tagged, else the
	// first action returned (`evaluateTx` ordering varies across providers).
	const mintBudget = evaluated.find((action) => action.tag === 'MINT')?.budget ?? evaluated[0]?.budget;
	if (mintBudget == null) {
		throw new Error('evaluateTx returned no MINT budget for V2 registry UpdateAction');
	}

	return await generateRegistryUpdateTransaction(
		blockchainProvider,
		network,
		script,
		walletAddress,
		recipientWalletAddress,
		fundingLovelace,
		policyId,
		oldAssetName,
		newAssetName,
		assetUtxo,
		collateralUtxo,
		utxos,
		metadata,
		mintBudget,
		rpcApiKey,
		walletSplitterLovelace,
	);
}

async function generateRegistryUpdateTransaction(
	blockchainProvider: IFetcher,
	network: Network,
	script: {
		version: LanguageVersion;
		code: string;
	},
	walletAddress: string,
	recipientWalletAddress: string,
	fundingLovelace: string,
	policyId: string,
	oldAssetName: string,
	newAssetName: string,
	assetUtxo: UTxO,
	collateralUtxo: UTxO,
	utxos: UTxO[],
	metadata: RegistryMetadata,
	exUnits: {
		mem: number;
		steps: number;
	} = SERVICE_CONSTANTS.SMART_CONTRACT.defaultExUnits,
	rpcApiKey?: string,
	walletSplitterLovelace?: bigint,
) {
	if (rpcApiKey) {
		await syncMeshCostModelsFromChain(rpcApiKey);
	}
	const cachedParams = rpcApiKey == null ? null : getCachedChainProtocolParameters(rpcApiKey);
	const protocolParameters = cachedParams ?? (await blockchainProvider.fetchProtocolParameters(Number.NaN));
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
	});
	txBuilder.protocolParams(protocolParameters);
	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

	// Burn-old + mint-new are two mint legs under one UpdateAction policy bucket.
	// Mesh's `mint()` flushes the PREVIOUS leg via `queueMint()`, which throws
	// `queueMint: Missing mint script information` unless that leg already carries
	// its `scriptSource` — so the script + redeemer must be attached to EACH leg,
	// not once after both (doing it once threw as soon as the mint-new `mint()`
	// flushed the unscripted burn-old leg). `mintPlutusScript()` also only arms
	// the very next `mint()`, so it precedes each. `queueMint` then merges both
	// same-policy legs into one bucket (it asserts the redeemer + scriptSource are
	// identical across legs, which they are).
	txBuilder
		.txIn(assetUtxo.input.txHash, assetUtxo.input.outputIndex)
		.mintPlutusScript(script.version)
		.mint('-1', policyId, oldAssetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: V2_UPDATE_REDEEMER_ALTERNATIVE, fields: [] }, 'Mesh', exUnits)
		.mintPlutusScript(script.version)
		.mint(SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity, policyId, newAssetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: V2_UPDATE_REDEEMER_ALTERNATIVE, fields: [] }, 'Mesh', exUnits)
		.metadataValue(SERVICE_CONSTANTS.METADATA.nftLabel, {
			[policyId]: {
				[newAssetName]: metadata,
			},
			version: '1',
		})
		.txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral(SERVICE_CONSTANTS.SMART_CONTRACT.collateralAmount)
		.txOut(recipientWalletAddress, [
			{
				unit: policyId + newAssetName,
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

	if (walletSplitterLovelace != null) {
		txBuilder.txOut(walletAddress, [{ unit: 'lovelace', quantity: walletSplitterLovelace.toString() }]);
	}

	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.setNetwork(network)
		.metadataValue(SERVICE_CONSTANTS.METADATA.masumiLabel, {
			msg: ['Masumi', 'UpdateAgent'],
		})
		.changeAddress(walletAddress)
		.complete();
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
	walletSplitterLovelace?: bigint,
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

	// Optional V2 single-item splitter — see param docstring on the public
	// `generateRegistryDeregisterTransactionAutomaticFees` entry above.
	if (walletSplitterLovelace != null) {
		txBuilder.txOut(walletAddress, [{ unit: 'lovelace', quantity: walletSplitterLovelace.toString() }]);
	}

	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.setNetwork(network)
		.metadataValue(SERVICE_CONSTANTS.METADATA.masumiLabel, { msg: ['Masumi', 'DeregisterAgent'] })
		.changeAddress(walletAddress)
		.complete();
}
