import 'dotenv/config';
import { Transaction } from '@meshsdk/core';
import {
	blockchainProvider,
	firstWalletAddress,
	loadWallet,
	network,
	readAddressOrWallet,
} from './example-helpers.mjs';

console.log('UTxO cleanup starting...');

const walletIndex = Number(process.env.WALLET_INDEX ?? 1);
const wallet = loadWallet(walletIndex);
const address = await readAddressOrWallet(walletIndex, wallet);
const changeAddress = await firstWalletAddress(wallet);
const lovelace = process.env.CLEANUP_LOVELACE ?? '70000000';
const utxos = await wallet.getUtxos();

if (utxos.length === 0) {
	throw new Error('No UTXOs found in the wallet.');
}

const tx = new Transaction({ initiator: wallet, fetcher: blockchainProvider });
tx.setTxInputs(utxos);
tx.sendLovelace({ address }, lovelace);
tx.setRequiredSigners([address]).setChangeAddress(changeAddress).setNetwork(network);

const unsignedTx = await tx.build();
const signedTx = await wallet.signTx(unsignedTx, true);
const txHash = await wallet.submitTx(signedTx);

console.log(`UTXO cleanup transaction:
    Tx ID: ${txHash}
    View: https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
`);
