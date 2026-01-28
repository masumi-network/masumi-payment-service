import { MeshWallet } from '@meshsdk/core';
import fs from 'node:fs';

if (!fs.existsSync('wallet_1.sk')) {
	let secret_key = MeshWallet.brew(false);

	fs.writeFileSync('wallet_1.sk', secret_key.join(' '));

	const wallet = new MeshWallet({
		networkId: 0,
		key: {
			type: 'mnemonic',
			words: secret_key,
		},
	});

	fs.writeFileSync('wallet_1.addr', wallet.getUnusedAddresses()[0]);
	console.log(`Wallet address generated: ${wallet.getUnusedAddresses()[0]}`);
} else {
	console.log('Wallet_1 does exist, skipped...');
}
if (!fs.existsSync('wallet_2.sk')) {
	const secret_key2 = MeshWallet.brew(false);

	fs.writeFileSync('wallet_2.sk', secret_key2.join(' '));

	const wallet2 = new MeshWallet({
		networkId: 0,
		key: {
			type: 'mnemonic',
			words: secret_key2,
		},
	});

	fs.writeFileSync('wallet_2.addr', (await wallet2.getUnusedAddresses())[0]);
	console.log(`Other Wallet address generated: ${(await wallet2.getUnusedAddresses())[0]}`);
} else {
	console.log('Wallet_2 does exist, skipped...');
}
if (!fs.existsSync('wallet_3.sk')) {
	const secret_key3 = MeshWallet.brew(false);

	fs.writeFileSync('wallet_3.sk', secret_key3.join(' '));

	const wallet3 = new MeshWallet({
		networkId: 0,
		key: {
			type: 'mnemonic',
			words: secret_key3,
		},
	});

	fs.writeFileSync('wallet_3.addr', wallet3.getUnusedAddresses()[0]);
	console.log(`Other Wallet address generated: ${wallet3.getUnusedAddresses()[0]}`);
} else {
	console.log('Wallet_3 does exist, skipped...');
}

if (!fs.existsSync('wallet_4.sk')) {
	const secret_key4 = MeshWallet.brew(false);

	fs.writeFileSync('wallet_4.sk', secret_key4.join(' '));

	const wallet4 = new MeshWallet({
		networkId: 0,
		key: {
			type: 'mnemonic',
			words: secret_key4,
		},
	});

	fs.writeFileSync('wallet_4.addr', wallet4.getUnusedAddresses()[0]);
	console.log(`Other Wallet address generated: ${wallet4.getUnusedAddresses()[0]}`);
} else {
	console.log('Wallet_4 does exist, skipped...');
}

if (!fs.existsSync('wallet_5.sk')) {
	const secret_key5 = MeshWallet.brew(false);

	fs.writeFileSync('wallet_5.sk', secret_key5.join(' '));

	const wallet5 = new MeshWallet({
		networkId: 0,
		key: {
			type: 'mnemonic',
			words: secret_key5,
		},
	});

	fs.writeFileSync('wallet_5.addr', wallet5.getUnusedAddresses()[0]);
	console.log(`Other Wallet address generated: ${wallet5.getUnusedAddresses()[0]}`);
} else {
	console.log('Wallet_5 does exist, skipped...');
}
