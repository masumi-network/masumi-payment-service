import { MeshTxBuilder } from '@meshsdk/core';
import {
	Action,
	assetNameFromUtxo,
	blockchainProvider,
	cardanoscanTransactionUrl,
	differentUtxos,
	firstWalletAddress,
	loadRegistryScript,
	loadWallet,
	network,
	waitForKoiosCip25Metadata,
	waitForKoiosAssetMetadata,
} from './example-helpers.mjs';

console.log('Minting V2 registry limit-test assets in one transaction');

function parsePositiveInteger(value, label) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== String(value).trim()) {
		throw new Error(`${label} must be a positive integer.`);
	}
	return parsed;
}

function parseNonceStart(value) {
	if (!/^[0-9a-fA-F]{2}$/.test(value)) {
		throw new Error('MINT_LIMIT_NONCE_START must be exactly 1 byte / 2 hex characters.');
	}
	const nonceStart = Number.parseInt(value, 16);
	if (nonceStart <= 0x0f) {
		throw new Error('MINT_LIMIT_NONCE_START must be between 10 and ff.');
	}
	return nonceStart;
}

function lovelaceQuantity(utxo) {
	return BigInt(utxo.output.amount.find((asset) => asset.unit === 'lovelace')?.quantity ?? '0');
}

function compareLovelaceDescending(left, right) {
	const leftLovelace = lovelaceQuantity(left);
	const rightLovelace = lovelaceQuantity(right);
	if (leftLovelace === rightLovelace) {
		return 0;
	}
	return leftLovelace < rightLovelace ? 1 : -1;
}

function onlyLovelace(utxo) {
	return utxo.output.amount.every((asset) => asset.unit === 'lovelace');
}

const mintCount = parsePositiveInteger(process.env.MINT_LIMIT_COUNT ?? '25', 'MINT_LIMIT_COUNT');
const nonceStart = parseNonceStart(process.env.MINT_LIMIT_NONCE_START ?? '10');
const nonceEnd = nonceStart + mintCount - 1;

if (nonceEnd > 0xff) {
	throw new Error('MINT_LIMIT_COUNT exceeds the available one-byte nonce range.');
}

const wallet = loadWallet();
const walletAddress = await firstWalletAddress(wallet);
const recipientAddress = process.env.RECIPIENT_ADDRESS ?? walletAddress;
const { policyId, script, scriptAddress } = loadRegistryScript();
const utxos = await wallet.getUtxos();

if (utxos.length < 2) {
	throw new Error('At least two wallet UTxOs are required: one mint seed input and one collateral input.');
}

const sortedPureLovelaceUtxos = utxos.filter(onlyLovelace).sort(compareLovelaceDescending);
const sortedUtxos = [...utxos].sort(compareLovelaceDescending);
const seedUtxo = sortedPureLovelaceUtxos[0] ?? sortedUtxos[0];
const collateralUtxo =
	sortedPureLovelaceUtxos.find(
		(utxo) =>
			differentUtxos(utxo, seedUtxo) &&
			lovelaceQuantity(utxo) >= BigInt(process.env.TOTAL_COLLATERAL ?? '5000000'),
	) ?? sortedUtxos.find((utxo) => differentUtxos(utxo, seedUtxo));

if (!collateralUtxo) {
	throw new Error('A separate collateral UTxO is required to mint registry tokens.');
}

const nonces = Array.from({ length: mintCount }, (_value, index) =>
	(nonceStart + index).toString(16).padStart(2, '0'),
);
const assetNames = nonces.map((nonce, index) =>
	assetNameFromUtxo(seedUtxo, nonce, `MINT_LIMIT_NONCES[${index}]`),
);
const metadataByAssetName = {};

for (const [index, assetName] of assetNames.entries()) {
	metadataByAssetName[assetName] = {
		tags: [['limit-test', '.de']],
		image: process.env.IMAGE_URL ?? 'ipfs://example',
		name: `${process.env.AGENT_NAME ?? 'Registry V2 Limit Agent'} ${index + 1}`,
		api_url: process.env.API_URL ?? 'http://localhost:3002',
		description: process.env.DESCRIPTION ?? 'Example Masumi registry V2 limit-test NFT',
		company_name: process.env.COMPANY_NAME ?? 'Example Inc.',
		capability: {
			name: process.env.CAPABILITY_NAME ?? 'HelloAI',
			version: process.env.CAPABILITY_VERSION ?? '1.0.0',
		},
		agentPricing: {
			pricingType: 'Fixed',
			fixedPricing: [
				{
					amount: Number(process.env.FIXED_PRICE_AMOUNT ?? 250000),
					unit: process.env.FIXED_PRICE_UNIT ?? '',
				},
			],
		},
	};
}

const txBuilder = new MeshTxBuilder({
	fetcher: blockchainProvider,
	evaluator: blockchainProvider,
});
const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

txBuilder.txIn(seedUtxo.input.txHash, seedUtxo.input.outputIndex);
txBuilder.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex);
txBuilder.setTotalCollateral(process.env.TOTAL_COLLATERAL ?? '5000000');

for (const assetName of assetNames) {
	txBuilder
		.mintPlutusScript(script.version)
		.mint('1', policyId, assetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: Action.MintAction, fields: [] }, 'Mesh');
}

txBuilder
	.metadataValue(721, {
		[policyId]: metadataByAssetName,
		version: '1',
	})
	.txOut(recipientAddress, [
		...assetNames.map((assetName) => ({ unit: policyId + assetName, quantity: '1' })),
		{ unit: 'lovelace', quantity: process.env.REGISTRY_OUTPUT_LOVELACE ?? '5000000' },
	]);

const unsignedTx = await txBuilder
	.requiredSignerHash(deserializedAddress.pubKeyHash)
	.setNetwork(network)
	.metadataValue(674, { msg: ['Masumi', 'MintLimitRegistryV2', String(mintCount)] })
	.changeAddress(walletAddress)
	.complete();

const signedTx = await wallet.signTx(unsignedTx, true);
const txHash = await wallet.submitTx(signedTx);
const assetIds = assetNames.map((assetName) => policyId + assetName);

console.log(`Minted ${mintCount} V2 registry limit-test assets:
    Tx ID: ${txHash}
    View: ${cardanoscanTransactionUrl(txHash)}
    Nonces: ${nonces[0]}..${nonces.at(-1)}
    Inputs: 1 seed input plus collateral
    ASSET_NAMES=${assetNames.join(',')}
    PolicyId: ${policyId}
    Policy address: ${scriptAddress}
`);

if (process.env.MINT_LIMIT_CHECK_KOIOS === '1') {
	console.log('Waiting for Koios to return CIP-25 metadata for the minted assets...');
	const koiosCip25Metadata = await waitForKoiosCip25Metadata(txHash, policyId, assetNames);
	console.log(`Koios CIP-25 metadata picked up:
${JSON.stringify(koiosCip25Metadata, null, 2)}
`);
	const koiosAssetSummary = await waitForKoiosAssetMetadata(assetIds);
	console.log(`Koios asset summary:
${JSON.stringify(koiosAssetSummary, null, 2)}
`);
}
