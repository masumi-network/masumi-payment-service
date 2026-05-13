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

console.log('Minting 3 V2 registry example assets in one transaction');

const wallet = loadWallet();
const walletAddress = await firstWalletAddress(wallet);
const recipientAddress = process.env.RECIPIENT_ADDRESS ?? walletAddress;
const { policyId, script, scriptAddress } = loadRegistryScript();
const utxos = await wallet.getUtxos();

if (utxos.length < 2) {
	throw new Error('At least two wallet UTxOs are required: one mint seed input and one collateral input.');
}

const seedUtxo = utxos[0];
const collateralUtxo =
	utxos.find(
		(utxo) =>
			differentUtxos(utxo, seedUtxo) &&
			utxo.output.amount.every((asset) => asset.unit === 'lovelace'),
	) ?? utxos.find((utxo) => differentUtxos(utxo, seedUtxo));

if (!collateralUtxo) {
	throw new Error('A separate collateral UTxO is required to mint registry tokens.');
}

const assetNonces = (process.env.ASSET_NONCES ?? '10,11,12').split(/[,\s]+/).filter(Boolean);
if (assetNonces.length !== 3) {
	throw new Error('ASSET_NONCES must contain exactly 3 one-byte hex nonces.');
}

const assetNames = assetNonces.map((nonce, index) =>
	assetNameFromUtxo(seedUtxo, nonce, `ASSET_NONCES[${index}]`),
);
if (new Set(assetNames).size !== assetNames.length) {
	throw new Error('ASSET_NONCES must derive 3 unique asset names.');
}

const metadataByAssetName = {};
for (const [index, assetName] of assetNames.entries()) {
	const assetNumber = index + 1;
	metadataByAssetName[assetName] = {
		tags: [['test', '.de']],
		image: process.env.IMAGE_URL ?? 'ipfs://example',
		name: `${process.env.AGENT_NAME ?? 'Registry V2 Example Agent'} ${assetNumber}`,
		api_url: process.env.API_URL ?? 'http://localhost:3002',
		description: process.env.DESCRIPTION ?? 'Example Masumi registry V2 NFT',
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
txBuilder.txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex);
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

for (const utxo of utxos) {
	if (differentUtxos(utxo, seedUtxo) && differentUtxos(utxo, collateralUtxo)) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}
}

const unsignedTx = await txBuilder
	.requiredSignerHash(deserializedAddress.pubKeyHash)
	.setNetwork(network)
	.metadataValue(674, { msg: ['Masumi', 'Mint3RegistryV2'] })
	.changeAddress(walletAddress)
	.complete();

const signedTx = await wallet.signTx(unsignedTx, true);
const txHash = await wallet.submitTx(signedTx);
const assetIds = assetNames.map((assetName) => policyId + assetName);

console.log(`Minted 3 V2 registry assets:
    Tx ID: ${txHash}
    View: ${cardanoscanTransactionUrl(txHash)}
    ASSET_NAMES=${assetNames.join(',')}
    PolicyId: ${policyId}
    AssetIds:
${assetIds.map((assetId) => `      ${assetId}`).join('\n')}
    Policy address: ${scriptAddress}
`);

console.log('Waiting for Koios to return CIP-25 metadata for the minted assets...');
const koiosCip25Metadata = await waitForKoiosCip25Metadata(txHash, policyId, assetNames);
console.log(`Koios CIP-25 metadata picked up:
${JSON.stringify(koiosCip25Metadata, null, 2)}
`);
const koiosAssetSummary = await waitForKoiosAssetMetadata(assetIds);
console.log(`Koios asset summary:
${JSON.stringify(koiosAssetSummary, null, 2)}
`);
