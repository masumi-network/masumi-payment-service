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
} from './example-helpers.mjs';

console.log('Burning V2 registry example asset');

const wallet = loadWallet();
const walletAddress = await firstWalletAddress(wallet);
const { policyId, script, scriptAddress } = loadRegistryScript();
const assetName = process.env.ASSET_NAME;

if (!assetName) {
	throw new Error('Set ASSET_NAME=<asset-name-hex> for the registry token to burn.');
}

const assetId = policyId + assetName;
const utxos = await wallet.getUtxos();
const assetUtxo = findAssetUtxo(utxos, assetId);
const collateralUtxo =
	utxos.find(
		(utxo) =>
			differentUtxos(utxo, assetUtxo) &&
			utxo.output.amount.every((asset) => asset.unit === 'lovelace'),
	) ?? utxos.find((utxo) => differentUtxos(utxo, assetUtxo));

if (!collateralUtxo) {
	throw new Error('A separate collateral UTxO is required to burn a registry token.');
}
const txBuilder = new MeshTxBuilder({
	fetcher: blockchainProvider,
	evaluator: blockchainProvider,
});
const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

txBuilder
	.txIn(assetUtxo.input.txHash, assetUtxo.input.outputIndex)
	.mintPlutusScript(script.version)
	.mint('-1', policyId, assetName)
	.mintingScript(script.code)
	.mintRedeemerValue({ alternative: Action.BurnAction, fields: [] }, 'Mesh')
	.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
	.setTotalCollateral(process.env.TOTAL_COLLATERAL ?? '5000000');

txBuilder.txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex);

for (const utxo of utxos) {
	if (differentUtxos(utxo, assetUtxo) && differentUtxos(utxo, collateralUtxo)) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}
}

const unsignedTx = await txBuilder
	.requiredSignerHash(deserializedAddress.pubKeyHash)
	.setNetwork(network)
	.metadataValue(674, { msg: ['Masumi', 'BurnRegistryV2'] })
	.changeAddress(walletAddress)
	.complete();

const signedTx = await wallet.signTx(unsignedTx, true);
const txHash = await wallet.submitTx(signedTx);

console.log(`Burned 1 V2 registry asset:
    Tx ID: ${txHash}
    View: ${cardanoscanTransactionUrl(txHash)}
    AssetName: ${assetName}
    PolicyId: ${policyId}
    AssetId: ${assetId}
    Policy address: ${scriptAddress}
`);
