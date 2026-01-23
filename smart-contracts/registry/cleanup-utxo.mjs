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
    words: fs.readFileSync('wallet.sk').toString().split(' '),
  },
});

const address = (await wallet.getUnusedAddresses())[0];

const tx = new Transaction({ initiator: wallet });
tx.sendLovelace(address, '120000000');
tx.setRequiredSigners([address]).setChangeAddress(address).setNetwork(network);

const unsignedTx = await tx.build();
const signedTx = await wallet.signTx(unsignedTx, true);
const txHash = await wallet.submitTx(signedTx);

console.log(`UTXO cleanup via:
    Tx ID: ${txHash}
    
`);
