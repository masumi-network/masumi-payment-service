import { resolvePlutusScriptAddress, BlockfrostProvider, MeshWallet, Transaction, KoiosProvider } from '@meshsdk/core';

import 'dotenv/config';

const network = 'preprod';
const blockchainProvider = new KoiosProvider(network);
//default policy of the contract
const policyId = '21209760fa48f204dd0d7d1b624e5b33b11fb9dd3a2a4071cdfd8e93';
const assetName = 'a55e19bdad5f135c1d0721ff8441fba2bb9ed611a9931bb060788d9eeec91a72';
const metadata = await blockchainProvider.fetchAssetMetadata(policyId + assetName);
console.log('Metadata', metadata);
