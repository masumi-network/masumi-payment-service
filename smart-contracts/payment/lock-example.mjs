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

const address = (await wallet.getUsedAddresses())[0];
console.log(address);

const blueprint = JSON.parse(fs.readFileSync('./plutus.json'));

const admin1 = fs.readFileSync('wallet_3.addr').toString();
const admin2 = fs.readFileSync('wallet_4.addr').toString();
const admin3 = fs.readFileSync('wallet_5.addr').toString();
console.log(resolvePaymentKeyHash(admin1));
console.log(resolvePaymentKeyHash(admin2));
console.log(resolvePaymentKeyHash(admin3));
const script = {
  code: applyParamsToScript(blueprint.validators[0].compiledCode, [
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
  ]),
  version: 'V3',
};

const utxos = await wallet.getUtxos();
if (utxos.length === 0) {
  //this is if the buyer wallet is empty
  throw new Error('No UTXOs found in the wallet. Wallet is empty.');
}

const buyer = (await wallet.getUsedAddresses())[0];
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
const refundTime = Date.now() + 1000 * 60 * 60 * 24 * 30 * 3; //* 60; //* 24 * 30;
const datum = {
  value: {
    alternative: 0,
    fields: [
      buyerVerificationKeyHash,
      sellerVerificationKeyHash,
      'test_1238091298389124991297247921793h214bfubasfjklnasvjnsacoinasoidnoiadsnoaiusfniuasdnbiuanwdiu12312ono1i2u4niou12n4iuon21oi4n213321io123n123',
      '',
      submitResultTime,
      //unlock time after specified time
      unlockTime,
      //refund time after specified time
      refundTime,
      //is converted to false
      mBool(false),
      //is converted to false
      mBool(false),
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
      network === 'preview'
        ? 'preview.'
        : network === 'preprod'
          ? 'preprod.'
          : ''
    }cardanoscan.io/transaction/${txHash}
    Address: ${resolvePlutusScriptAddress(script, 0)}
`);
