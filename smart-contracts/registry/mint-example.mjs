import cbor from 'cbor';
import {
  resolvePlutusScriptAddress,
  MeshWallet,
  Transaction,
  KoiosProvider,
  applyParamsToScript,
} from '@meshsdk/core';
import fs from 'node:fs';
import { deserializePlutusScript } from '@meshsdk/core-cst';
import 'dotenv/config';
import { blake2b } from 'ethereum-cryptography/blake2b.js';

console.log('Minting example asset');
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

const blueprint = JSON.parse(fs.readFileSync('./plutus.json'));
const paymentContractAddress =
  'addr_test1wzlwhustapq9ck0zdz8dahhwd350nzlpg785nz7hs0tqjtgdy4230';

const script = {
  code: applyParamsToScript(blueprint.validators[0].compiledCode, [
    paymentContractAddress,
  ]),
  version: 'V3',
};

const utxos = await wallet.getUtxos();
if (utxos.length === 0) {
  throw new Error('No UTXOs found for the specified wallet');
}

const firstUtxo = utxos[0];

const txId = firstUtxo.input.txHash;
const txIndex = firstUtxo.input.outputIndex;
const serializedOutput = txId + txIndex.toString(16).padStart(8, '0');

const serializedOutputUint8Array = new Uint8Array(
  Buffer.from(serializedOutput.toString('hex'), 'hex'),
);
// Hash the serialized output using blake2b_256
const blake2b256 = blake2b(serializedOutputUint8Array, 32);
let assetName = Buffer.from(blake2b256).toString('hex');

const redeemer = {
  data: { alternative: 0, fields: [] },
  tag: 'MINT',
};
const policyId = deserializePlutusScript(script.code, script.version)
  .hash()
  .toString();

const tx = new Transaction({ initiator: wallet }).setTxInputs([
  //ensure our first utxo hash (serializedOutput) is used as first input
  firstUtxo,
  ...utxos.slice(1),
]);

tx.isCollateralNeeded = true;

//setup minting data separately as the minting function does not work well with hex encoded strings without some magic
tx.txBuilder
  .mintPlutusScript(script.version)
  .mint('1', policyId, assetName)
  .mintingScript(script.code)
  .mintRedeemerValue(redeemer.data, 'Mesh');

//setup the metadata
tx.setMetadata(721, {
  [policyId]: {
    [assetName]: {
      tags: [['test', '.de']],
      image: 'abc.de',
      //name can be freely chosen
      name: 'Registry Example NAME',
      api_url: 'http://localhost:3002',
      description: 'This is a valid second example NFT for the registry',
      company_name: 'Example Inc.',
      capability: { name: 'HelloAI', version: '1.3.2.1' },
      agentPricing: {
        pricingType: 'Fixed',
        fixedPricing: [
          {
            amount: 250000,
            unit: '',
          },
        ],
      },
    },
  },
});
//send the minted asset to the address where we want to receive payments
tx.sendAssets(address, [{ unit: policyId + assetName, quantity: '1' }])
  //used to defrag for further transactions
  .sendLovelace(address, '120000000');
//sign the transaction with our address
tx.setRequiredSigners([address]).setChangeAddress(address).setNetwork(network);
//build the transaction
const unsignedTx = await tx.build();
const signedTx = await wallet.signTx(unsignedTx, true);
//submit the transaction to the blockchain, it can take a bit until the transaction is confirmed and found on the explorer
const txHash = await wallet.submitTx(signedTx);

console.log(`Minted 1 asset with the contract at:
    Tx ID: ${txHash}
    View (after a bit) on https://${
      network === 'preprod' ? 'preprod.' : ''
    }cardanoscan.io/transaction/${txHash}
    AssetName: ${assetName}
    PolicyId: ${policyId}
    AssetId: ${policyId + assetName}
    Address: ${resolvePlutusScriptAddress(script, 0)}
`);
