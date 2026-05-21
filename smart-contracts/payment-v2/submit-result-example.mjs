import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Transaction } from '@meshsdk/core';
import {
	Action,
	actionData,
	applyValidity,
	assertHex,
	blockchainProvider,
	cloneDatumFields,
	datumFromFields,
	fetchContractUtxo,
	firstWalletAddress,
	loadPaymentScript,
	loadWallet,
	network,
	nextCooldownTime,
	readAddressOrWallet,
	readDatumFields,
	State,
	stateAlternative,
	stateData,
} from './example-helpers.mjs';

console.log('Submitting result as V2 payment example');

const wallet = loadWallet(2);
const address = await firstWalletAddress(wallet);
const sellerAddress = await readAddressOrWallet(2, wallet);
const { script, scriptAddress } = loadPaymentScript();
const utxo = await fetchContractUtxo(blockchainProvider, scriptAddress);
const fields = cloneDatumFields(readDatumFields(utxo));

const resultHash =
	process.env.RESULT_HASH ??
	createHash('sha256')
		.update(process.env.RESULT_TEXT ?? 'example-result')
		.digest('hex');
assertHex(resultHash, 'RESULT_HASH');

const currentState = stateAlternative(fields[18]);
fields[11] = resultHash;
fields[16] = nextCooldownTime();
fields[17] = 0n;
fields[18] = stateData(
	currentState === State.FundsLocked || currentState === State.ResultSubmitted
		? State.ResultSubmitted
		: State.Disputed,
);

const tx = new Transaction({ initiator: wallet, fetcher: blockchainProvider })
	.redeemValue({
		value: utxo,
		script,
		redeemer: actionData(Action.SubmitResult),
	})
	.sendAssets({ address: scriptAddress, datum: datumFromFields(fields) }, utxo.output.amount)
	.setChangeAddress(address)
	.setRequiredSigners([sellerAddress]);

await applyValidity(tx);
const unsignedTx = await tx.build();
const signedTx = await wallet.signTx(unsignedTx);
const txHash = await wallet.submitTx(signedTx);

console.log(`Created V2 submit result transaction:
    Tx ID: ${txHash}
    Result hash: ${resultHash}
    View: https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Contract address: ${scriptAddress}
`);
