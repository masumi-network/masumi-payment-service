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
	parseAssetNames,
	waitForKoiosAssetMetadata,
} from './example-helpers.mjs';

console.log('Burning 3 V2 registry example assets in one transaction');

const assetNamesInCode = [
	'105e0ccdcf19d19c478180cf3db1bf014649699e01b62ac4672e1ee05b000002',
	'115e0ccdcf19d19c478180cf3db1bf014649699e01b62ac4672e1ee05b000002',
	'125e0ccdcf19d19c478180cf3db1bf014649699e01b62ac4672e1ee05b000002',
];
const assetNamesInput =
	process.env.ASSET_NAMES ??
	(assetNamesInCode.length > 0 ? assetNamesInCode.join(',') : undefined);

function includesUtxo(utxos, candidate) {
	return utxos.some((utxo) => !differentUtxos(utxo, candidate));
}

const wallet = loadWallet();
const walletAddress = await firstWalletAddress(wallet);
const { policyId, script, scriptAddress } = loadRegistryScript();
const assetNames = parseAssetNames(assetNamesInput);
const utxos = await wallet.getUtxos();
const assetUtxos = [];

for (const assetName of assetNames) {
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
	throw new Error('A separate collateral UTxO is required to burn registry tokens.');
}

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

for (const assetName of assetNames) {
	txBuilder
		.mintPlutusScript(script.version)
		.mint('-1', policyId, assetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: Action.BurnAction, fields: [] }, 'Mesh');
}

for (const utxo of utxos) {
	if (!includesUtxo(assetUtxos, utxo) && differentUtxos(utxo, collateralUtxo)) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}
}

const unsignedTx = await txBuilder
	.requiredSignerHash(deserializedAddress.pubKeyHash)
	.setNetwork(network)
	.metadataValue(674, { msg: ['Masumi', 'Burn3RegistryV2'] })
	.changeAddress(walletAddress)
	.complete();

const signedTx = await wallet.signTx(unsignedTx, true);
const txHash = await wallet.submitTx(signedTx);
const assetIds = assetNames.map((assetName) => policyId + assetName);

console.log(`Burned 3 V2 registry assets:
    Tx ID: ${txHash}
    View: ${cardanoscanTransactionUrl(txHash)}
    ASSET_NAMES=${assetNames.join(',')}
    PolicyId: ${policyId}
    AssetIds:
${assetIds.map((assetId) => `      ${assetId}`).join('\n')}
    Policy address: ${scriptAddress}
`);

console.log('Checking Koios can still return CIP-25 metadata for the burned asset IDs...');
const koiosMetadata = await waitForKoiosAssetMetadata(assetIds);
console.log(`Koios metadata found:
${JSON.stringify(koiosMetadata, null, 2)}
`);
