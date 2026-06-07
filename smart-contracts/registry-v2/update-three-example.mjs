import { MeshTxBuilder } from '@meshsdk/core';
import {
	Action,
	blockchainProvider,
	cardanoscanTransactionUrl,
	differentUtxos,
	findAssetUtxo,
	firstWalletAddress,
	loadRegistryScript,
	loadWallet,
	network,
	nextAssetName,
	parseAssetNames,
	waitForKoiosCip25Metadata,
	waitForKoiosAssetMetadata,
} from './example-helpers.mjs';

console.log('Updating 3 V2 registry example assets in one transaction');

const assetNamesInCode = [
	'105e0ccdcf19d19c478180cf3db1bf014649699e01b62ac4672e1ee05b000001',
	'115e0ccdcf19d19c478180cf3db1bf014649699e01b62ac4672e1ee05b000001',
	'125e0ccdcf19d19c478180cf3db1bf014649699e01b62ac4672e1ee05b000001',
];
const assetNamesInput =
	process.env.ASSET_NAMES ??
	(assetNamesInCode.length > 0 ? assetNamesInCode.join(',') : undefined);

function includesUtxo(utxos, candidate) {
	return utxos.some((utxo) => !differentUtxos(utxo, candidate));
}

const wallet = loadWallet();
const walletAddress = await firstWalletAddress(wallet);
const recipientAddress = process.env.RECIPIENT_ADDRESS ?? walletAddress;
const { policyId, script, scriptAddress } = loadRegistryScript();
const oldAssetNames = parseAssetNames(assetNamesInput);
const newAssetNames = oldAssetNames.map(nextAssetName);
const utxos = await wallet.getUtxos();
const assetUtxos = [];

for (const assetName of oldAssetNames) {
	const assetUtxo = findAssetUtxo(utxos, policyId + assetName);
	if (!includesUtxo(assetUtxos, assetUtxo)) {
		assetUtxos.push(assetUtxo);
	}
}

const collateralUtxo =
	utxos.find(
		(utxo) =>
			!includesUtxo(assetUtxos, utxo) &&
			utxo.output.amount.every((asset) => asset.unit === 'lovelace'),
	) ?? utxos.find((utxo) => !includesUtxo(assetUtxos, utxo));

if (!collateralUtxo) {
	throw new Error('A separate collateral UTxO is required to update registry tokens.');
}

const metadataByAssetName = {};
for (const [index, assetName] of newAssetNames.entries()) {
	const assetNumber = index + 1;
	metadataByAssetName[assetName] = {
		tags: [['test', '.de']],
		image: process.env.IMAGE_URL ?? 'ipfs://example',
		name: `${process.env.AGENT_NAME ?? 'Registry V2 Updated Agent'} ${assetNumber}`,
		api_url: process.env.API_URL ?? 'http://localhost:3002',
		description: process.env.DESCRIPTION ?? 'Updated Masumi registry V2 NFT',
		company_name: process.env.COMPANY_NAME ?? 'Example Inc.',
		capability: {
			name: process.env.CAPABILITY_NAME ?? 'HelloAI',
			version: process.env.CAPABILITY_VERSION ?? '1.0.1',
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

const expectedKoiosCip25Metadata = {
	[policyId]: metadataByAssetName,
	version: '1',
};

const txBuilder = new MeshTxBuilder({
	fetcher: blockchainProvider,
	evaluator: blockchainProvider,
});
const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

for (const utxo of assetUtxos) {
	txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
}

txBuilder.txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex);
txBuilder.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex);
txBuilder.setTotalCollateral(process.env.TOTAL_COLLATERAL ?? '5000000');

for (const assetName of oldAssetNames) {
	txBuilder
		.mintPlutusScript(script.version)
		.mint('-1', policyId, assetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: Action.UpdateAction, fields: [] }, 'Mesh');
}

for (const assetName of newAssetNames) {
	txBuilder
		.mintPlutusScript(script.version)
		.mint('1', policyId, assetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: Action.UpdateAction, fields: [] }, 'Mesh');
}

txBuilder
	.metadataValue(721, expectedKoiosCip25Metadata)
	.txOut(recipientAddress, [
		...newAssetNames.map((assetName) => ({ unit: policyId + assetName, quantity: '1' })),
		{ unit: 'lovelace', quantity: process.env.REGISTRY_OUTPUT_LOVELACE ?? '5000000' },
	]);

for (const utxo of utxos) {
	if (!includesUtxo(assetUtxos, utxo) && differentUtxos(utxo, collateralUtxo)) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}
}

const unsignedTx = await txBuilder
	.requiredSignerHash(deserializedAddress.pubKeyHash)
	.setNetwork(network)
	.metadataValue(674, { msg: ['Masumi', 'Update3RegistryV2'] })
	.changeAddress(walletAddress)
	.complete();

const signedTx = await wallet.signTx(unsignedTx, true);
const txHash = await wallet.submitTx(signedTx);
const newAssetIds = newAssetNames.map((assetName) => policyId + assetName);

console.log(`Updated 3 V2 registry assets:
    Tx ID: ${txHash}
    View: ${cardanoscanTransactionUrl(txHash)}
    Old ASSET_NAMES=${oldAssetNames.join(',')}
    ASSET_NAMES=${newAssetNames.join(',')}
    PolicyId: ${policyId}
    AssetIds:
${newAssetIds.map((assetId) => `      ${assetId}`).join('\n')}
    Policy address: ${scriptAddress}
`);

console.log('Waiting for Koios to return CIP-25 metadata for the updated assets...');
console.log(`Expected Koios label 721 metadata:
${JSON.stringify(expectedKoiosCip25Metadata, null, 2)}
`);
const koiosCip25Metadata = await waitForKoiosCip25Metadata(txHash, policyId, newAssetNames);
console.log(`Koios label 721 metadata returned:
${JSON.stringify(koiosCip25Metadata, null, 2)}
`);
const koiosAssetSummary = await waitForKoiosAssetMetadata(newAssetIds);
console.log(`Koios asset summary:
${JSON.stringify(koiosAssetSummary, null, 2)}
`);
