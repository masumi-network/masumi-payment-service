import fs from 'node:fs';
import { MeshWallet } from '@meshsdk/core';
import { networkId } from './example-helpers.mjs';

// wallet_1 owns the wallet, wallet_2 is the delegated agent, wallet_3 stands in
// for an allow-listed recipient.
async function generateWallet(walletIndex, role) {
	const secretPath = `wallet_${walletIndex}.sk`;
	const addressPath = `wallet_${walletIndex}.addr`;

	if (fs.existsSync(secretPath)) {
		console.log(`wallet_${walletIndex} (${role}) exists, skipped`);
		return;
	}

	const secretKey = MeshWallet.brew(false);
	fs.writeFileSync(secretPath, secretKey.join(' '));

	const wallet = new MeshWallet({
		networkId,
		key: {
			type: 'mnemonic',
			words: secretKey,
		},
	});
	const address = (await wallet.getUnusedAddresses())[0];

	fs.writeFileSync(addressPath, address);
	console.log(`wallet_${walletIndex} (${role}) generated: ${address}`);
}

await generateWallet(1, 'owner');
await generateWallet(2, 'agent');
await generateWallet(3, 'recipient');
await generateWallet(4, 'co-signer');
await generateWallet(5, 'co-signer');
await generateWallet(6, 'co-signer');
