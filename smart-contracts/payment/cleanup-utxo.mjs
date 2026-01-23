import { BlockfrostProvider, KoiosProvider, MeshWallet, Transaction } from '@meshsdk/core';
import fs from 'node:fs';
import 'dotenv/config';

const network = 'preprod';
const blockchainProvider = new KoiosProvider(network);

const wallet = new MeshWallet({
  networkId: 0,
  fetcher: blockchainProvider,
  submitter: blockchainProvider,
  key: {
    type: 'mnemonic',
    words: fs.readFileSync('wallet_1.sk').toString().split(' '),
  },
});
console.log('Utxo cleanup starting...');

const address = await wallet.getAddresses();
console.log(address.baseAddressBech32);
const utxos = await wallet.getUtxos();

const tx = new Transaction({ initiator: wallet });
tx.setTxInputs(utxos);
tx.sendLovelace(address, '70000000');
tx.setRequiredSigners([address]).setChangeAddress(address).setNetwork(network);

const unsignedTx = await tx.build();
const signedTx = await wallet.signTx(unsignedTx, true);
const txHash = await wallet.submitTx(signedTx);

console.log(`UTXO cleanup via:
    Tx ID: view on https://${
      network === 'preprod' ? 'preprod.' : ''
    }cardanoscan.io/transaction/${txHash}
`);
