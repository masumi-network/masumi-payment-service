import { MeshWallet } from '@meshsdk/core';
import fs from 'node:fs';

async function generateWallet(walletIndex) {
	const secretPath = `wallet_${walletIndex}.sk`;
	const addressPath = `wallet_${walletIndex}.addr`;

	if (fs.existsSync(secretPath)) {
		console.log(`Wallet_${walletIndex} does exist, skipped...`);
		return;
	}

	const secretKey = MeshWallet.brew(false);
	fs.writeFileSync(secretPath, secretKey.join(' '));

	const wallet = new MeshWallet({
		networkId: 0,
		key: {
			type: 'mnemonic',
			words: secretKey,
		},
	});
	const address = (await wallet.getUnusedAddresses())[0];

	fs.writeFileSync(addressPath, address);
	console.log(`Wallet_${walletIndex} address generated: ${address}`);
}

await generateWallet(1);
await generateWallet(2);
await generateWallet(3);
await generateWallet(4);
await generateWallet(5);
