import { MeshWallet } from '@meshsdk/core';
import fs from 'node:fs';

if (!fs.existsSync('wallet.sk')) {
	const secretKey = MeshWallet.brew(false);
	fs.writeFileSync('wallet.sk', secretKey.join(' '));

	const wallet = new MeshWallet({
		networkId: 0,
		key: {
			type: 'mnemonic',
			words: secretKey,
		},
	});
	const address = (await wallet.getUnusedAddresses())[0];

	fs.writeFileSync('wallet.addr', address);
	console.log(`Wallet address generated: ${address}`);
} else {
	console.log('Wallet does exist, skipped...');
}
