import 'dotenv/config';
import { Transaction } from '@meshsdk/core';
import {
	blockchainProvider,
	createInitialDatum,
	firstWalletAddress,
	loadPaymentScript,
	loadWallet,
	network,
	readAddress,
	readAddressOrWallet,
} from './example-helpers.mjs';

console.log('Locking funds as V2 payment example');

const wallet = loadWallet(1);
const buyerAddress = await readAddressOrWallet(1, wallet);
const sellerAddress = readAddress(2);
const lockLovelace = process.env.LOCK_LOVELACE ?? '5000000';
const { scriptAddress } = loadPaymentScript();

const utxos = await wallet.getUtxos();
if (utxos.length === 0) {
	throw new Error('No UTXOs found in the buyer wallet.');
}

const datum = createInitialDatum({ buyerAddress, sellerAddress });
const unsignedTx = await new Transaction({ initiator: wallet, fetcher: blockchainProvider })
	.sendLovelace(
		{
			address: scriptAddress,
			datum,
		},
		lockLovelace,
	)
	.setChangeAddress(await firstWalletAddress(wallet))
	.setNetwork(network)
	.build();

const signedTx = await wallet.signTx(unsignedTx);
const txHash = await wallet.submitTx(signedTx);

console.log(`Created initial V2 payment transaction:
    Tx ID: ${txHash}
    View: https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
    Contract address: ${scriptAddress}
`);
