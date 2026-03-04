import cbor from 'cbor';
import { resolvePlutusScriptAddress, MeshWallet, Transaction, KoiosProvider, applyParamsToScript } from '@meshsdk/core';
import fs from 'node:fs';
import { deserializePlutusScript } from '@meshsdk/core-cst';
import 'dotenv/config';
import { blake2b } from 'ethereum-cryptography/blake2b.js';

console.log('Burning example asset');
const network = 'preprod';
const blockchainProvider = new KoiosProvider(network);

const wallet = new MeshWallet({
	networkId: 0,
	fetcher: blockchainProvider,
	submitter: blockchainProvider,
	key: {
		type: 'mnemonic',
		words: fs.readFileSync('wallet.sk').toString().split(' '),
	},
});

const address = (await wallet.getUnusedAddresses())[0];

const blueprint = JSON.parse(fs.readFileSync('./plutus.json'));

const paymentContractAddress = 'addr_test1wrm4l7k9qgw9878ymvw223u45fje48tnhqsxk2tewe47z7se03mca';

const script = {
	code: applyParamsToScript(blueprint.validators[0].compiledCode, [paymentContractAddress]),
	version: 'V3',
};

const utxos = await wallet.getUtxos();
if (utxos.length === 0) {
	throw new Error('No UTXOs found for the wallet');
}

//configure the asset to be burned here
let assetName = '0754980f1942dd9a4fce18392eb792b009f78f7150a459d29fdc2e526ac5373c';

const redeemer = {
	data: { alternative: 1, fields: [] },
	tag: 'BURN',
};
const policyId = deserializePlutusScript(script.code, script.version).hash().toString();
const tx = new Transaction({ initiator: wallet }).setTxInputs(utxos);

tx.isCollateralNeeded = true;

//setup minting data separately as the minting function does not work well with hex encoded strings without some magic
tx.txBuilder
	.mintPlutusScript(script.version)
	.mint('-1', policyId, assetName)
	.mintingScript(script.code)
	.mintRedeemerValue(redeemer.data, 'Mesh');
//setup the metadata
tx.burnAsset;
//send the minted asset to the address where we want to receive payments
//used to defrag for further transactions
tx.sendLovelace(address, '120000000');
//sign the transaction with our address
tx.setRequiredSigners([address]).setChangeAddress(address).setNetwork(network);
//build the transaction
const unsignedTx = await tx.build();
const signedTx = await wallet.signTx(unsignedTx, true);
//submit the transaction to the blockchain, it can take a bit until the transaction is confirmed and found on the explorer
const txHash = await wallet.submitTx(signedTx);

console.log(`Burned 1 asset with the contract at:
    Tx ID: ${txHash}
    View (after a bit) on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    AssetName: ${assetName}
    PolicyId: ${policyId}
    Address: ${resolvePlutusScriptAddress(script, 0)}
`);
