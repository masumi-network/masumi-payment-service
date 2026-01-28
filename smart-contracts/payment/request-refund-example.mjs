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
	pubKeyAddress,
	resolveStakeKeyHash,
} from '@meshsdk/core';
import fs from 'node:fs';
import 'dotenv/config';

console.log('Requesting refund example');
const network = 'preprod';
const blockchainProvider = new KoiosProvider(network);

const wallet = new MeshWallet({
	networkId: 0,
	fetcher: blockchainProvider,
	submitter: blockchainProvider,
	key: {
		type: 'mnemonic',
		words: fs.readFileSync('wallet_1.sk').toString().split(' '),
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
	//this is if the buyer wallet is empty
	throw new Error('No UTXOs found in the wallet. Wallet is empty.');
}
async function fetchUtxo(txHash) {
	const utxos = await blockchainProvider.fetchAddressUTxOs(resolvePlutusScriptAddress(script, 0));
	return utxos.find((utxo) => {
		return utxo.input.txHash == txHash;
	});
}

const utxo = await fetchUtxo('126afe16205e3617e15fb655f9656004441f2ab7851e666c10ce47186180d6b0');

if (!utxo) {
	throw new Error('UTXO not found');
}

// Decode the CBOR-encoded datum

const buyer = (await wallet.getUnusedAddresses())[0];
const buyerVerificationKeyHash = resolvePaymentKeyHash(buyer);

const sellerAddress = fs.readFileSync('wallet_2.addr').toString();
const sellerVerificationKeyHash = resolvePaymentKeyHash(sellerAddress);

const utxoDatum = utxo.output.plutusData;
if (!utxoDatum) {
	throw new Error('No datum found in UTXO');
}

const decodedDatum = cbor.decode(Buffer.from(utxoDatum, 'hex'));
if (typeof decodedDatum.value[5] !== 'number') {
	throw new Error('Invalid datum at position 4');
}
if (typeof decodedDatum.value[6] !== 'number') {
	throw new Error('Invalid datum at position 5');
}
const hash = decodedDatum.value[4];
const submitResultTime = decodedDatum.value[5];
const unlockTime = decodedDatum.value[6];
const externalDisputeUnlockTime = decodedDatum.value[7];
const sellerCooldownTime = decodedDatum.value[8];
const buyerCooldownTime = Date.now() + 1000 * 60 * 35;
console.log(hash.toString('hex'));
const decodedHash = hash.toString('utf-8');
console.log(decodedHash);

const datum = {
	value: {
		alternative: 0,
		fields: [
			buyerVerificationKeyHash,
			sellerVerificationKeyHash,
			'test',
			'',
			decodedHash,
			submitResultTime,
			unlockTime,
			externalDisputeUnlockTime,
			0,
			buyerCooldownTime,
			{
				alternative: 3,
				fields: [],
			},
		],
	},
	inline: true,
};
/*
//this will only work after the unlock time
  Withdraw
  //this will set the refund_requested to True and auto approved after the refund time, can only be called before the unlock time
  RequestRefund
  //this will cancel any refund request and unlock the funds (immediately if the unlock time is over)
  CancelRefundRequest
  //is implicitly allowed if the refund was requested and the refund time is over (and not denied)
  WithdrawRefund
  //this will set the refund_denied to True and prevent any withdrawal
  DenyRefund
*/
const redeemer = {
	data: {
		alternative: 1,
		fields: [],
	},
};
const invalidBefore = unixTimeToEnclosingSlot(Date.now() - 150000, SLOT_CONFIG_NETWORK.preprod) - 1;
const invalidHereafter = unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK.preprod) + 1;

const unsignedTx = new Transaction({
	initiator: wallet,
	fetcher: blockchainProvider,
})
	.redeemValue({
		value: utxo,
		script: script,
		redeemer: redeemer,
	})
	.sendValue({ address: resolvePlutusScriptAddress(script, 0), datum: datum }, utxo)
	.setChangeAddress(address)
	.setRequiredSigners([address]);

unsignedTx.setNetwork(network);

unsignedTx.txBuilder.invalidBefore(invalidBefore);
unsignedTx.txBuilder.invalidHereafter(invalidHereafter);
const buildTransaction = await unsignedTx.build();
const signedTx = await wallet.signTx(buildTransaction);

//submit the transaction to the blockchain
const txHash = await wallet.submitTx(signedTx);

console.log(`Created withdrawal transaction:
    Tx ID: ${txHash}
    View (after a bit) on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Address: ${resolvePlutusScriptAddress(script, 0)}
`);
