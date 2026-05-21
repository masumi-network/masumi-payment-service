import 'dotenv/config';
import { Transaction } from '@meshsdk/core';
import {
	Action,
	actionData,
	applyValidity,
	blockchainProvider,
	cloneDatumFields,
	datumFromFields,
	fetchContractUtxo,
	firstWalletAddress,
	isEmptyByteString,
	loadPaymentScript,
	loadWallet,
	network,
	nextCooldownTime,
	readAddressOrWallet,
	readDatumFields,
	State,
	stateData,
} from './example-helpers.mjs';

console.log('Requesting refund as V2 payment example');

const wallet = loadWallet(1);
const address = await firstWalletAddress(wallet);
const buyerAddress = await readAddressOrWallet(1, wallet);
const { script, scriptAddress } = loadPaymentScript();
const utxo = await fetchContractUtxo(blockchainProvider, scriptAddress);
const fields = cloneDatumFields(readDatumFields(utxo));

fields[16] = 0n;
fields[17] = nextCooldownTime();
fields[18] = stateData(isEmptyByteString(fields[11]) ? State.RefundRequested : State.Disputed);

const tx = new Transaction({ initiator: wallet, fetcher: blockchainProvider })
	.redeemValue({
		value: utxo,
		script,
		redeemer: actionData(Action.SetRefundRequested),
	})
	.sendAssets({ address: scriptAddress, datum: datumFromFields(fields) }, utxo.output.amount)
	.setChangeAddress(address)
	.setRequiredSigners([buyerAddress]);

await applyValidity(tx);
const unsignedTx = await tx.build();
const signedTx = await wallet.signTx(unsignedTx);
const txHash = await wallet.submitTx(signedTx);

console.log(`Created V2 refund request transaction:
    Tx ID: ${txHash}
    View: https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Contract address: ${scriptAddress}
`);
