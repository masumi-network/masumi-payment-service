import 'dotenv/config';
import { Transaction } from '@meshsdk/core';
import {
	Action,
	actionData,
	adminSignatureData,
	applyValidity,
	assetsMinusLovelace,
	assetsToAssetValueData,
	autoPickTimedOutDispute,
	blockchainProvider,
	disputeIntentHash,
	explicitContractRef,
	fetchContractUtxo,
	firstWalletAddress,
	hasAssets,
	loadPaymentScript,
	loadWallet,
	lovelaceAsset,
	network,
	readAddress,
	subtractAssets,
	syncCostModelsFromChain,
	taggedRecipient,
} from './example-helpers.mjs';

await syncCostModelsFromChain();

console.log('Withdrawing disputed funds as V2 payment example');

const adminWallet1 = loadWallet(3);
const adminWallet2 = loadWallet(4);
const feePayerAddress = await firstWalletAddress(adminWallet1);
const buyerAddress = process.env.BUYER_RETURN_ADDRESS ?? readAddress(1);
const sellerAddress = process.env.SELLER_RETURN_ADDRESS ?? readAddress(2);
const { script, scriptAddress } = loadPaymentScript();

// Either spend an explicit ref (TX_HASH env / first argv) or auto-pick the
// oldest Disputed UTxO past its external_dispute_unlock_time.
let utxo;
if (explicitContractRef() != null) {
	utxo = await fetchContractUtxo(blockchainProvider, scriptAddress);
	console.log(`Using explicit UTxO ${utxo.input.txHash}#${utxo.input.outputIndex}`);
} else {
	utxo = await autoPickTimedOutDispute(blockchainProvider, scriptAddress);
	if (!utxo) {
		throw new Error(
			'No timed-out Disputed UTxO found at script address. Pass TX_HASH=<hex> or wait for external_dispute_unlock_time.',
		);
	}
	console.log(`Auto-picked Disputed UTxO ${utxo.input.txHash}#${utxo.input.outputIndex}`);
}

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

await applyValidity(tx);
const unsignedTx = await tx.build();
const signedTx = await adminWallet1.signTx(unsignedTx);
const txHash = await adminWallet1.submitTx(signedTx);

console.log(`Created V2 dispute withdrawal transaction:
    Tx ID: ${txHash}
    Signed intent hash: ${intentHash}
    View: https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Contract address: ${scriptAddress}
`);
