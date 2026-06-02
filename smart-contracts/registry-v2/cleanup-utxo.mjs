import { Transaction } from '@meshsdk/core';
import {
	blockchainProvider,
	cardanoscanTransactionUrl,
	firstWalletAddress,
	loadWallet,
	network,
} from './example-helpers.mjs';

console.log('Registry V2 UTxO cleanup starting...');

const wallet = loadWallet();
const address = await firstWalletAddress(wallet);
const lovelace = process.env.CLEANUP_LOVELACE ?? '120000000';
const utxos = await wallet.getUtxos();

if (utxos.length === 0) {
	throw new Error('No UTxOs found in the wallet.');
}

const tx = new Transaction({ initiator: wallet, fetcher: blockchainProvider });
tx.setTxInputs(utxos);
tx.sendLovelace({ address }, lovelace);
tx.setRequiredSigners([address]).setChangeAddress(address).setNetwork(network);

const unsignedTx = await tx.build();
const signedTx = await wallet.signTx(unsignedTx, true);
const txHash = await wallet.submitTx(signedTx);

console.log(`Registry V2 UTxO cleanup transaction:
    Tx ID: ${txHash}
    View: ${cardanoscanTransactionUrl(txHash)}
`);
