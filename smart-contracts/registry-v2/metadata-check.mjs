import {
	blockchainProvider,
	loadRegistryScript,
} from './example-helpers.mjs';

const { policyId } = loadRegistryScript();
const assetName = process.env.ASSET_NAME;

if (!assetName) {
	throw new Error('Set ASSET_NAME=<asset-name-hex> to fetch registry metadata.');
}

const metadata = await blockchainProvider.fetchAssetMetadata(policyId + assetName);
console.log('Metadata', metadata);
