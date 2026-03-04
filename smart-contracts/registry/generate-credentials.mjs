import { MeshWallet } from '@meshsdk/core';
import fs from 'node:fs';

const secret_key = MeshWallet.brew(false);
if (!fs.existsSync('wallet.sk')) {
	fs.writeFileSync('wallet.sk', secret_key.join(' '));

	const wallet = new MeshWallet({
		networkId: 0,
		key: {
			type: 'mnemonic',
			words: secret_key,
		},
	});

	fs.writeFileSync('wallet.addr', wallet.getUnusedAddresses()[0]);
	console.log(`Wallet address generated: ${wallet.getUnusedAddresses()[0]}`);
} else {
	console.log('Wallet does exist, skipped...');
}
