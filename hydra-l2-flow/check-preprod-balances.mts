import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeshWallet } from '@meshsdk/core';

const DIR = join(process.cwd(), 'hydra-l2-flow', 'preprod');
const bfKey =
	process.env.BLOCKFROST_API_KEY_PREPROD?.replace(/"/g, '') ??
	readFileSync(join(DIR, 'blockfrost.txt'), 'utf-8').trim();

async function addrOf(skFile: string): Promise<string> {
	const { cborHex } = JSON.parse(readFileSync(join(DIR, skFile), 'utf-8')) as { cborHex: string };
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'cli', payment: cborHex } });
	await (wallet as unknown as { init?: () => Promise<void> }).init?.();
	return wallet.getAddresses().enterpriseAddressBech32 ?? (await wallet.getChangeAddress());
}

for (const [name, sk] of [
	['purchasing-cardano (funds + node1 fuel)', 'purchasing-cardano.sk'],
	['selling-cardano    (node2 fuel)', 'selling-cardano.sk'],
] as const) {
	const addr = await addrOf(sk);
	const res = await fetch(`https://cardano-preprod.blockfrost.io/api/v0/addresses/${addr}/utxos`, {
		headers: { project_id: bfKey },
	});
	if (res.status === 404) {
		console.log(`${name}\n  ${addr}\n  balance: 0 ADA (address unused)\n`);
		continue;
	}
	if (!res.ok) {
		console.log(`${name}\n  ${addr}\n  blockfrost error ${res.status}\n`);
		continue;
	}
	const utxos = (await res.json()) as { amount: { unit: string; quantity: string }[] }[];
	const lovelace = utxos.reduce(
		(s, u) => s + BigInt(u.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0'),
		0n,
	);
	const per = utxos
		.map((u) => Number(u.amount.find((a) => a.unit === 'lovelace')?.quantity ?? 0) / 1e6)
		.sort((a, b) => b - a)
		.slice(0, 6);
	console.log(`${name}\n  ${addr}\n  balance: ${Number(lovelace) / 1e6} ADA in ${utxos.length} UTxO(s) ${JSON.stringify(per)}\n`);
}
