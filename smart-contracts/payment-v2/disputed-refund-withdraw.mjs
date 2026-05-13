import 'dotenv/config';
import { Transaction } from '@meshsdk/core';
import {
	Action,
	actionData,
	adminSignatureData,
	applyValidity,
	assetsMinusLovelace,
	assetsToAssetValueData,
	blockchainProvider,
	disputeIntentHash,
	fetchContractUtxo,
	firstWalletAddress,
	hasAssets,
	loadPaymentScript,
	loadWallet,
	lovelaceAsset,
	network,
	readAddress,
	subtractAssets,
	taggedRecipient,
} from './example-helpers.mjs';

console.log('Withdrawing disputed funds as V2 payment example');

const adminWallet1 = loadWallet(3);
const adminWallet2 = loadWallet(4);
const feePayerAddress = await firstWalletAddress(adminWallet1);
const buyerAddress = process.env.BUYER_RETURN_ADDRESS ?? readAddress(1);
const sellerAddress = process.env.SELLER_RETURN_ADDRESS ?? readAddress(2);
const { script, scriptAddress } = loadPaymentScript();
const utxo = await fetchContractUtxo(blockchainProvider, scriptAddress);

const buyerLovelace = BigInt(process.env.BUYER_LOVELACE ?? 0);
const buyerAssets = buyerLovelace > 0n ? lovelaceAsset(buyerLovelace) : [];
const sellerAssets =
	buyerLovelace > 0n
		? assetsMinusLovelace(utxo.output.amount, buyerLovelace)
		: subtractAssets(utxo.output.amount, []);

const buyerValueData = assetsToAssetValueData(buyerAssets);
const sellerValueData = assetsToAssetValueData(sellerAssets);
const intentHash = disputeIntentHash(utxo, buyerValueData, sellerValueData);
const adminSignatures = [
	await adminSignatureData(adminWallet1, intentHash),
	await adminSignatureData(adminWallet2, intentHash),
];

let tx = new Transaction({ initiator: adminWallet1, fetcher: blockchainProvider }).redeemValue({
	value: utxo,
	script,
	redeemer: actionData(Action.WithdrawDisputed, [
		buyerValueData,
		sellerValueData,
		adminSignatures,
	]),
});

if (hasAssets(buyerAssets)) {
	tx = tx.sendAssets(taggedRecipient(buyerAddress, utxo), buyerAssets);
}

if (hasAssets(sellerAssets)) {
	tx = tx.sendAssets(taggedRecipient(sellerAddress, utxo), sellerAssets);
}

tx = tx.setChangeAddress(feePayerAddress).setRequiredSigners([feePayerAddress]);

applyValidity(tx);
const unsignedTx = await tx.build();
const signedTx = await adminWallet1.signTx(unsignedTx);
const txHash = await adminWallet1.submitTx(signedTx);

console.log(`Created V2 dispute withdrawal transaction:
    Tx ID: ${txHash}
    Signed intent hash: ${intentHash}
    View: https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Contract address: ${scriptAddress}
`);
