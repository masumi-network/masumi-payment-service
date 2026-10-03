/**
 * Phase 2 — read the seeded local hot wallet and derive its L1 address.
 * Run: DATABASE_URL=<test-db> pnpm exec tsx hydra-l2-flow/01-wallet.mts
 */
import { prisma } from '@masumi/payment-core/db';
import { decrypt } from '@/utils/security/encryption';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { resolvePaymentKeyHash } from '@meshsdk/core';

async function main() {
	const head = await prisma.hydraHead.findFirstOrThrow({
		include: {
			LocalParticipant: { include: { Wallet: { include: { Secret: true, PaymentSource: true } } } },
			HydraRelation: true,
		},
	});
	const wallet = head.LocalParticipant!.Wallet;
	const network = wallet.PaymentSource.network;
	const mnemonic = decrypt(wallet.Secret.encryptedMnemonic).split(' ');
	const mw = generateOfflineWallet(network, mnemonic);
	const address = (await mw.getUnusedAddresses())[0] ?? mw.getUsedAddress().toBech32();
	const vkey = resolvePaymentKeyHash(address);

	console.log(JSON.stringify({
		headId: head.id,
		headStatus: head.status,
		headIdentifier: head.headIdentifier,
		network,
		localHotWalletId: wallet.id,
		walletType: wallet.type,
		smartContractAddress: wallet.PaymentSource.smartContractAddress,
		paymentSourceId: wallet.PaymentSource.id,
		address,
		vkey,
		collectionAddress: wallet.collectionAddress,
	}, null, 2));

	await prisma.$disconnect();
	process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
