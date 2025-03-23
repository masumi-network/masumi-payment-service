import {
  resolvePlutusScriptAddress,
  resolvePaymentKeyHash,
  pubKeyAddress,
  resolveStakeKeyHash,
  KoiosProvider,
  MeshWallet,
  Transaction,
  mBool,
  applyParamsToScript,
  integer,
  list,
  deserializeAddress,
  resolveDataHash,
  conStr0,
} from '@meshsdk/core';
import fs from 'node:fs';
import 'dotenv/config';
import { PlutusData, toPlutusData } from '@meshsdk/core-cst';

console.log('Locking funds as example');

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

const blueprint = JSON.parse(fs.readFileSync('./plutus.json'));

const admin1 = fs.readFileSync('wallet_3.addr').toString();
const admin2 = fs.readFileSync('wallet_4.addr').toString();
const admin3 = fs.readFileSync('wallet_5.addr').toString();
const script = {
  code: applyParamsToScript(blueprint.validators[0].compiledCode, [
    2,
    [
      resolvePaymentKeyHash(admin1),
      resolvePaymentKeyHash(admin2),
      resolvePaymentKeyHash(admin3),
    ],
    //yes I love meshJs
    {
      alternative: 0,
      fields: [
        {
          alternative: 0,
          fields: [resolvePaymentKeyHash(admin1)],
        },
        {
          alternative: 0,
          fields: [
            {
              alternative: 0,
              fields: [
                {
                  alternative: 0,
                  fields: [resolveStakeKeyHash(admin1)],
                },
              ],
            },
          ],
        },
      ],
    },
    50,
    1000 * 60 * 15,
  ]),
  version: 'V3',
};

const utxos = await wallet.getUtxos();
if (utxos.length === 0) {
  //this is if the buyer wallet is empty
  throw new Error('No UTXOs found in the wallet. Wallet is empty.');
}

const buyer = (await wallet.getUnusedAddresses())[0];
const buyerVerificationKeyHash = resolvePaymentKeyHash(buyer);

const sellerAddress = fs.readFileSync('wallet_2.addr').toString();
const sellerVerificationKeyHash = resolvePaymentKeyHash(sellerAddress);
/*
buyer: VerificationKeyHash,
  seller: VerificationKeyHash,
  referenceId: ByteArray,
  resultHash: ByteArray,
  unlock_time: POSIXTime,
  refund_time: POSIXTime,
  refund_requested: Bool,
  refund_denied: Bool,
*/
const submitResultTime = Date.now() + 1000 * 60 * 60 * 24 * 30;
//1 minute unlock period
const unlockTime = Date.now() + 1000 * 60 * 60 * 24 * 30 * 2; // * 30;
//1 hour refund dispute period
const externalDisputeUnlockTime = Date.now() + 1000 * 60 * 60 * 24 * 30 * 3; //* 60; //* 24 * 30;
const sellerCooldownTime = Date.now() + 1000 * 15;
const buyerCooldownTime = Date.now() + 1000 * 15;
const datum = {
  value: {
    alternative: 0,
    fields: [
      buyerVerificationKeyHash,
      sellerVerificationKeyHash,
      'test',
      '',
      '',
      submitResultTime,
      //unlock time after specified time
      unlockTime,
      //refund time after specified time
      externalDisputeUnlockTime,
      0,
      0,
      {
        alternative: 0,
        fields: [],
      },
    ],
  },
  inline: true,
};

const unsignedTx = await new Transaction({ initiator: wallet })
  .sendLovelace(
    {
      address: resolvePlutusScriptAddress(script, 0),
      datum,
    },
    '50000000',
  )
  .setNetwork(network)
  .build();

const signedTx = await wallet.signTx(unsignedTx);

//submit the transaction to the blockchain
const txHash = await wallet.submitTx(signedTx);

console.log(`Created initial transaction:
    Tx ID: ${txHash}
    View (after a bit) on https://${
      network === 'preprod' ? 'preprod.' : ''
    }cardanoscan.io/transaction/${txHash}
    Address: ${resolvePlutusScriptAddress(script, 0)}
`);
