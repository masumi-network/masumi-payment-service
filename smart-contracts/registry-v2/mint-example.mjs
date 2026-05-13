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
} from './example-helpers.mjs';

console.log('Minting V2 registry example asset');

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
const assetName = process.env.ASSET_NAME ?? assetNameFromUtxo(seedUtxo);
const txBuilder = new MeshTxBuilder({
	fetcher: blockchainProvider,
	evaluator: blockchainProvider,
});
const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);

txBuilder
	.txIn(seedUtxo.input.txHash, seedUtxo.input.outputIndex)
	.mintPlutusScript(script.version)
	.mint('1', policyId, assetName)
	.mintingScript(script.code)
	.mintRedeemerValue({ alternative: Action.MintAction, fields: [] }, 'Mesh')
	.metadataValue(721, {
		[policyId]: {
			[assetName]: {
				tags: [['test', '.de']],
				image: process.env.IMAGE_URL ?? 'ipfs://example',
				name: process.env.AGENT_NAME ?? 'Registry V2 Example Agent',
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
			},
		},
		version: '1',
	})
	.txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
	.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
	.setTotalCollateral(process.env.TOTAL_COLLATERAL ?? '5000000')
	.txOut(recipientAddress, [
		{ unit: policyId + assetName, quantity: '1' },
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
	.metadataValue(674, { msg: ['Masumi', 'MintRegistryV2'] })
	.changeAddress(walletAddress)
	.complete();

const signedTx = await wallet.signTx(unsignedTx, true);
const txHash = await wallet.submitTx(signedTx);

console.log(`Minted 1 V2 registry asset:
    Tx ID: ${txHash}
    View: ${cardanoscanTransactionUrl(txHash)}
    AssetName: ${assetName}
    PolicyId: ${policyId}
    AssetId: ${policyId + assetName}
    Policy address: ${scriptAddress}
`);
