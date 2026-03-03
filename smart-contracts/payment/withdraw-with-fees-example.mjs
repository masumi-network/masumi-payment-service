import cbor from 'cbor';
import {
	resolvePlutusScriptAddress,
	resolvePaymentKeyHash,
	KoiosProvider,
	SLOT_CONFIG_NETWORK,
	MeshWallet,
	Transaction,
	unixTimeToEnclosingSlot,
	mBool,
	applyParamsToScript,
	resolveStakeKeyHash,
	conStr,
	mOutputReference,
} from '@meshsdk/core';
import fs from 'node:fs';
import 'dotenv/config';
import { createHash } from 'node:crypto';
console.log('Withdrawing funds as example');
const network = 'preprod';
const blockchainProvider = new KoiosProvider(network);
const koios = new KoiosProvider('preprod');

const wallet = new MeshWallet({
	networkId: 0,
	fetcher: blockchainProvider,
	submitter: blockchainProvider,
	key: {
		type: 'mnemonic',
		words: fs.readFileSync('wallet_2.sk').toString().split(' '),
	},
});

const address = (await wallet.getUnusedAddresses())[0];
const blueprint = JSON.parse(fs.readFileSync('./plutus.json'));

const admin1 = fs.readFileSync('wallet_3.addr').toString();
const admin2 = fs.readFileSync('wallet_4.addr').toString();
const admin3 = fs.readFileSync('wallet_5.addr').toString();

const script = {
	code: applyParamsToScript(blueprint.validators[0].compiledCode, [
		2,
		[resolvePaymentKeyHash(admin1), resolvePaymentKeyHash(admin2), resolvePaymentKeyHash(admin3)],
		//yes I love meshJs
		{
			alternative: 0,
			fields: [
				{
					alternative: 0,
					fields: [resolvePaymentKeyHash(admin1)],
				},
				{
					alternative: 0,
					fields: [
						{
							alternative: 0,
							fields: [
								{
									alternative: 0,
									fields: [resolveStakeKeyHash(admin1)],
								},
							],
						},
					],
				},
			],
		},
		50,
		1000 * 60 * 15,
	]),
	version: 'V3',
};

const utxos = await wallet.getUtxos();
if (utxos.length === 0) {
	//this is if the seller wallet is empty
	throw new Error('No UTXOs found in the wallet. Wallet is empty.');
}
async function fetchUtxo(txHash) {
	const utxos = await blockchainProvider.fetchAddressUTxOs(resolvePlutusScriptAddress(script, 0));
	return utxos.find((utxo) => {
		return utxo.input.txHash == txHash;
	});
}

const utxo = await fetchUtxo('56e32326caa6ff4fac96a33c576120a061bfac94c7d47cba90100992618946ca');

if (!utxo) {
	throw new Error('UTXO not found');
}

const buyerAddress = fs.readFileSync('wallet_1.addr').toString();
const buyerVerificationKeyHash = resolvePaymentKeyHash(buyerAddress);

const sellerAddress = fs.readFileSync('wallet_2.addr').toString();
const sellerVerificationKeyHash = resolvePaymentKeyHash(sellerAddress);

const utxoDatum = utxo.output.plutusData;
if (!utxoDatum) {
	throw new Error('No datum found in UTXO');
}

const redeemer = {
	data: {
		alternative: 0,
		fields: [],
	},
};
const invalidBefore = unixTimeToEnclosingSlot(Date.now() - 150000, SLOT_CONFIG_NETWORK.preprod) - 1;

const invalidAfter = unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK.preprod) + 1;

const outputReference1 = mOutputReference('56e32326caa6ff4fac96a33c576120a061bfac94c7d47cba90100992618946ca', 0);

const unsignedTx = new Transaction({ initiator: wallet, fetcher: koios })
	.redeemValue({
		value: utxo,
		script: script,
		redeemer: redeemer,
	})
	.sendLovelace(
		{
			address: admin1,
			datum: {
				value: outputReference1,
				inline: true,
			},
		},
		//set to 5% of lovelace
		'2500000',
	)
	.sendLovelace(
		{
			address: buyerAddress,
			datum: {
				value: outputReference1,
				inline: true,
			},
		},
		'4000000',
	)
	.setChangeAddress(address)
	.setRequiredSigners([address]);

unsignedTx.txBuilder.invalidBefore(invalidBefore);
unsignedTx.txBuilder.invalidHereafter(invalidAfter);

unsignedTx.setNetwork(network);

const buildTransaction = await unsignedTx.build();
const signedTx = await wallet.signTx(buildTransaction);

//submit the transaction to the blockchain
const txHash = await wallet.submitTx(signedTx);

console.log(`Created withdrawal transaction:
    Tx ID: ${txHash}
    View (after a bit) on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Address: ${resolvePlutusScriptAddress(script, 0)}
`);
