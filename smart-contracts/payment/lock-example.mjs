import {
	resolvePlutusScriptAddress,
	resolvePaymentKeyHash,
	pubKeyAddress,
	resolveStakeKeyHash,
	KoiosProvider,
	MeshWallet,
	Transaction,
	mBool,
	applyParamsToScript,
	integer,
	list,
	deserializeAddress,
	resolveDataHash,
	conStr0,
	verificationKey,
	serializeAddressObj,
	mPubKeyAddress,
} from '@meshsdk/core';
import fs from 'node:fs';
import 'dotenv/config';
import { Address, BaseAddress, Credential, PlutusData, toPlutusData } from '@meshsdk/core-cst';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';

console.log('Locking funds as example');

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
console.log(await wallet.getUsedAddresses());

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

const buyer = (await wallet.getUnusedAddresses())[0];
const buyerVerificationKeyHash = resolvePaymentKeyHash(buyer);

const sellerAddress = fs.readFileSync('wallet_2.addr').toString();
const sellerVerificationKeyHash = resolvePaymentKeyHash(sellerAddress);
/*
  buyer: VerificationKeyHash,
  seller: VerificationKeyHash,
  reference_key: ByteArray,
  reference_signature: ByteArray,
  seller_nonce: ByteArray,
  buyer_nonce: ByteArray,
  collateral_return_lovelace: Int,
  input_hash: ByteArray,
  result_hash: ByteArray,
  pay_by_time: POSIXTime,
  submit_result_time: POSIXTime,
  unlock_time: POSIXTime,
  external_dispute_unlock_time: POSIXTime,
  seller_cooldown_time: POSIXTime,
  buyer_cooldown_time: POSIXTime,
  state: State,
*/
const payByTime = Date.now() + 1000 * 60 * 3;
const submitResultTime = Date.now() + 1000 * 60 * 5;
//1 minute unlock period
const unlockTime = Date.now() + 1000 * 60 * 12; // * 30;
//1 hour refund dispute period
const externalDisputeUnlockTime = Date.now() + 1000 * 60 * 12; //* 60; //* 24 * 30;
const sellerCooldownTime = Date.now() + 1000 * 15;
const buyerCooldownTime = Date.now() + 1000 * 15;

const addr = serializeAddressObj(pubKeyAddress(buyerVerificationKeyHash));
console.log(addr);

const datum = {
	value: {
		alternative: 0,
		fields: [
			mPubKeyAddress(buyerVerificationKeyHash, resolveStakeKeyHash(buyer)),
			mPubKeyAddress(sellerVerificationKeyHash, resolveStakeKeyHash(sellerAddress)),
			/*buyerVerificationKeyHash,
      sellerVerificationKeyHash,
      */

			'key',
			'0b00604c2066086046d04660138c0561014c0ecd485200d800e480634d96d9621004c144ec8eb4ee1b3406662c2fa42c0b9878c9a1a3484c2610c90803a4e853212a08944a2b109a6a688a16c610915691b084e470971285d6ddd61e7160698aae85c4023016def381094023d323b0797b6362b33321930020821a1191812591a2c022a2c422d991d2c1a0c8272251934081648a10a4220a0b5ae9736173b97320814321bbeb12b7f1437313698043491262c2570210fb1313610b7b418ac310c9fb11939242626166630317404f7217010af6b822c1b75171932242c3328424231c0a43d00d4260c067341021a750f038ec926024002103a1d0c0c03587160f8643d15a74392ad610848394d02f491d1960832191b09034300703119a6552bd58580a862426b84055640cd465c0248176a36a8e942901f3896907563a8c0957c7609630e42d9e0c456311cab06327160542e0c84e6c68311246536babf1205e360ee55681ac76d00b6919df10a52c2e72ba258e85c3718d609679341404924b082c525f021dc1360afcc21142144626c0267d92d854ba505591c980f2052289505280a9546ada200000',
			'',
			'',
			4000000,
			'',
			'',
			payByTime,
			submitResultTime,
			//unlock time after specified time
			unlockTime,
			//refund time after specified time
			externalDisputeUnlockTime,
			0,
			0,
			{
				alternative: 0,
				fields: [],
			},
		],
	},
	inline: true,
};

const unsignedTx = await new Transaction({ initiator: wallet })
	.sendLovelace(
		{
			address: resolvePlutusScriptAddress(script, 0),
			datum,
		},
		'4000000',
	)
	.setNetwork(network)
	.build();

const signedTx = await wallet.signTx(unsignedTx);

//submit the transaction to the blockchain
const txHash = await wallet.submitTx(signedTx);

console.log(`Created initial transaction:
    Tx ID: ${txHash}
    View (after a bit) on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Address: ${resolvePlutusScriptAddress(script, 0)}
`);
