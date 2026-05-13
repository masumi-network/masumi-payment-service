import 'dotenv/config';
import { Transaction } from '@meshsdk/core';
import {
	Action,
	actionData,
	applyValidity,
	blockchainProvider,
	fetchContractUtxo,
	firstWalletAddress,
	loadPaymentScript,
	loadWallet,
	network,
	readAddressOrWallet,
	taggedRecipient,
} from './example-helpers.mjs';

console.log('Withdrawing refund as V2 payment example');

const wallet = loadWallet(1);
const address = await firstWalletAddress(wallet);
const buyerAddress = await readAddressOrWallet(1, wallet);
const { script, scriptAddress } = loadPaymentScript();
const utxo = await fetchContractUtxo(blockchainProvider, scriptAddress);

const tx = new Transaction({ initiator: wallet, fetcher: blockchainProvider })
	.redeemValue({
		value: utxo,
		script,
		redeemer: actionData(Action.WithdrawRefund),
	})
	.sendAssets(taggedRecipient(buyerAddress, utxo), utxo.output.amount)
	.setChangeAddress(address)
	.setRequiredSigners([buyerAddress]);

applyValidity(tx);
const unsignedTx = await tx.build();
const signedTx = await wallet.signTx(unsignedTx);
const txHash = await wallet.submitTx(signedTx);

console.log(`Created V2 refund withdrawal transaction:
    Tx ID: ${txHash}
    View: https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Contract address: ${scriptAddress}
`);
