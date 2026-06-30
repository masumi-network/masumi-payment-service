/**
 * Helper — replace the seeded remote (seller) WalletBase's enterprise address
 * with a proper base address (payment+stake), required by the V2 datum builder
 * (getPubKeyBaseAddressDatum). Persists the seller mnemonic to a file so later
 * seller-side steps can sign.
 *
 * Run: DATABASE_URL=<test-db> pnpm exec tsx hydra-l2-flow/04-fix-seller.mts
 */
import { writeFileSync } from 'node:fs';
import { MeshWallet, resolvePaymentKeyHash } from '@meshsdk/core';
import { prisma } from '@masumi/payment-core/db';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { Network } from '@/generated/prisma/client';

async function main() {
	const mnemonic = MeshWallet.brew() as string[];
	const wallet = generateOfflineWallet(Network.Preprod, mnemonic);
	const address = (await wallet.getUnusedAddresses())[0] ?? wallet.getUsedAddress().toBech32();
	const vkey = resolvePaymentKeyHash(address);

	const relation = await prisma.hydraRelation.findFirstOrThrow();
	await prisma.walletBase.update({
		where: { id: relation.remoteWalletId },
		data: { walletAddress: address, walletVkey: vkey },
	});

	writeFileSync('hydra-l2-flow/.seller.json', JSON.stringify({ mnemonic, address, vkey }, null, 2));
	console.log('seller updated:', JSON.stringify({ remoteWalletId: relation.remoteWalletId, address, vkey }, null, 2));
	process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
