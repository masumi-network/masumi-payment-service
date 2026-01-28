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
	integer,
	BlockfrostProvider,
	MeshTxBuilder,
	mPubKeyAddress,
	serializeAddressObj,
	deserializeDatum,
} from '@meshsdk/core';
import fs from 'node:fs';
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { resolveStakeKeyHash } from '@meshsdk/core-cst';
console.log('Submitting result as example');
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

const signedData = await wallet.signData('test1234');
console.log(signedData.key);
console.log('signature', signedData.signature);

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
for (const utxo of utxos) {
	console.log(utxo.output.amount);
}
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

const utxo = await fetchUtxo('abfb0b30c03d903a6c6a05c5832abd0fbe71f7c0bd1368334a6b2a611b6d000b');

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

const decodedDatum = cbor.decode(Buffer.from(utxoDatum, 'hex'));
if (typeof decodedDatum.value[6] !== 'number') {
	throw new Error('Invalid datum at position 4');
}
if (typeof decodedDatum.value[9] !== 'number') {
	throw new Error('Invalid datum at position 5');
}
if (typeof decodedDatum.value[10] !== 'number') {
	throw new Error('Invalid datum at position 6');
}
if (typeof decodedDatum.value[11] !== 'number') {
	throw new Error('Invalid datum at position 7');
}
if (typeof decodedDatum.value[12] !== 'number') {
	throw new Error('Invalid datum at position 8');
}
if (typeof decodedDatum.value[13] !== 'number') {
	throw new Error('Invalid datum at position 9');
}
if (typeof decodedDatum.value[14] !== 'number') {
	throw new Error('Invalid datum at position 10');
}

const hash = 'abc_hash_of_the_result1';
const submitResultTime = decodedDatum.value[10];
const unlockTime = decodedDatum.value[11];
const externalDisputeUnlockTime = decodedDatum.value[12];
const sellerCooldownTime = Date.now() + 1000 * 60 * 35;
const payByTime = decodedDatum.value[9];
/*
const deserializedDatum = deserializeDatum(utxoDatum);
const decodedAddress = serializeAddressObj(deserializedDatum.fields[0]);
console.log(decodedAddress);
*/

const datum = {
	value: {
		alternative: 0,
		fields: [
			mPubKeyAddress(buyerVerificationKeyHash, resolveStakeKeyHash(buyerAddress)),
			mPubKeyAddress(sellerVerificationKeyHash, resolveStakeKeyHash(sellerAddress)),
			/*
      buyerVerificationKeyHash,
      sellerVerificationKeyHash,
      */
			'key',
			'0b00604c2066086046d04660138c0561014c0ecd485200d800e480634d96d9621004c144ec8eb4ee1b3406662c2fa42c0b9878c9a1a3484c2610c90803a4e853212a08944a2b109a6a688a16c610915691b084e470971285d6ddd61e7160698aae85c4023016def381094023d323b0797b6362b33321930020821a1191812591a2c022a2c422d991d2c1a0c8272251934081648a10a4220a0b5ae9736173b97320814321bbeb12b7f1437313698043491262c2570210fb1313610b7b418ac310c9fb11939242626166630317404f7217010af6b822c1b75171932242c3328424231c0a43d00d4260c067341021a750f038ec926024002103a1d0c0c03587160f8643d15a74392ad610848394d02f491d1960832191b09034300703119a6552bd58580a862426b84055640cd465c0248176a36a8e942901f3896907563a8c0957c7609630e42d9e0c456311cab06327160542e0c84e6c68311246536babf1205e360ee55681ac76d00b6919df10a52c2e72ba258e85c3718d609679341404924b082c525f021dc1360afcc21142144626c0267d92d854ba505591c980f2052289505280a9546ada200000',
			'',
			'',
			4000000,
			'',
			'test',
			payByTime,
			submitResultTime,
			unlockTime,
			externalDisputeUnlockTime,
			sellerCooldownTime,
			0,
			{
				alternative: 1,
				fields: [],
			},
		],
	},
	inline: true,
};

const redeemer = {
	data: {
		alternative: 5,
		fields: [],
	},
};
const invalidBefore = unixTimeToEnclosingSlot(Date.now() - 150000, SLOT_CONFIG_NETWORK.preprod) - 1;

const invalidAfter = unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK.preprod) + 1;

const unsignedTx = new Transaction({ initiator: wallet, fetcher: koios })
	.redeemValue({
		value: utxo,
		script: script,
		redeemer: redeemer,
	})
	.sendValue({ address: resolvePlutusScriptAddress(script, 0), datum: datum }, utxo)
	.setChangeAddress(address)
	.setRequiredSigners([address]);

unsignedTx.isCollateralNeeded = true;

const ctxbuilder = new MeshTxBuilder({
	fetcher: blockchainProvider,
});
const deserializedAddress = ctxbuilder.serializer.deserializer.key.deserializeAddress(address);
const ctx = await ctxbuilder
	.spendingPlutusScript(script.version)
	.txIn(
		utxo.input.txHash,
		utxo.input.outputIndex,
		utxo.output.amount,
		utxo.output.address,
		utxo.output.scriptRef ? utxo.output.scriptRef.length / 2 : 0,
	)
	.txInScript(script.code, script.version)
	.txInRedeemerValue(redeemer.data, 'Mesh', {
		mem: 7e6,
		steps: 3e9,
	})
	.txInInlineDatumPresent()
	.txInCollateral(utxos[1].input.txHash, utxos[1].input.outputIndex)
	.setTotalCollateral('5000000')
	.txOut(resolvePlutusScriptAddress(script, 0), utxo.output.amount)
	.txOutInlineDatumValue(datum.value)
	.txIn(utxos[0].input.txHash, utxos[0].input.outputIndex)
	.changeAddress(address)
	.invalidBefore(invalidBefore)
	.invalidHereafter(invalidAfter)
	.requiredSignerHash(deserializedAddress.pubKeyHash)
	.setNetwork(network)
	.metadataValue(674, {
		msg: ['Masumi', 'SubmitResult'],
	})
	.complete();

unsignedTx.txBuilder.invalidBefore(invalidBefore);
unsignedTx.txBuilder.invalidHereafter(invalidAfter);
unsignedTx.setNetwork(network);

const buildTransaction = await unsignedTx.build();
//const estimatedFee = await blockfrost.evaluateTx(ctx);
//console.log(estimatedFee);
const signedTx = await wallet.signTx(ctx);

//submit the transaction to the blockchain
const txHash = await wallet.submitTx(signedTx);

console.log(`Created submit result transaction:
    Tx ID: ${txHash}
    View (after a bit) on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Address: ${resolvePlutusScriptAddress(script, 0)}
`);
