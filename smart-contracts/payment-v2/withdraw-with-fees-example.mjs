import 'dotenv/config';
import { Transaction } from '@meshsdk/core';
import {
	Action,
	actionData,
	applyValidity,
	assetsMinusLovelace,
	blockchainProvider,
	fetchContractUtxo,
	firstWalletAddress,
	hasAssets,
	loadPaymentScript,
	loadWallet,
	lovelaceAsset,
	network,
	readAddress,
	readAddressOrWallet,
	readDatumFields,
	taggedRecipient,
} from './example-helpers.mjs';

console.log('Withdrawing completed payment as V2 payment example');

const wallet = loadWallet(2);
const address = await firstWalletAddress(wallet);
const buyerAddress = process.env.BUYER_RETURN_ADDRESS ?? readAddress(1);
const sellerSignerAddress = await readAddressOrWallet(2, wallet);
const sellerPayoutAddress = process.env.SELLER_RETURN_ADDRESS ?? sellerSignerAddress;
const { script, scriptAddress } = loadPaymentScript();
const utxo = await fetchContractUtxo(blockchainProvider, scriptAddress);
const fields = readDatumFields(utxo);
const collateralReturnLovelace = BigInt(fields[9]);
const sellerAssets = assetsMinusLovelace(utxo.output.amount, collateralReturnLovelace);

let tx = new Transaction({ initiator: wallet, fetcher: blockchainProvider }).redeemValue({
	value: utxo,
	script,
	redeemer: actionData(Action.Withdraw),
});

if (collateralReturnLovelace > 0n) {
	tx = tx.sendAssets(taggedRecipient(buyerAddress, utxo), lovelaceAsset(collateralReturnLovelace));
}

if (hasAssets(sellerAssets)) {
	tx = tx.sendAssets(taggedRecipient(sellerPayoutAddress, utxo), sellerAssets);
}

tx = tx.setChangeAddress(address).setRequiredSigners([sellerSignerAddress]);

applyValidity(tx);
const unsignedTx = await tx.build();
const signedTx = await wallet.signTx(unsignedTx);
const txHash = await wallet.submitTx(signedTx);

console.log(`Created V2 seller withdrawal transaction:
    Tx ID: ${txHash}
    View: https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Contract address: ${scriptAddress}
`);
