/**
 * Recover the V2 preprod fund wallets from the payment-service DB alone:
 * read WalletSecret.encryptedMnemonic, decrypt with ENCRYPTION_KEY, derive
 * the L1 addresses. This is the "DB + encryption key" recovery demonstration:
 * no wallet file, no hydra-node, no persistence involved.
 *
 * Run: DATABASE_URL=<test-db> pnpm exec tsx hydra-l2-flow/96-derive-db-wallets.mts
 */
import { prisma } from '@masumi/payment-core/db';
import { decrypt } from '@/utils/security/encryption';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { HotWalletType, Network, PaymentSourceType } from '@/generated/prisma/client';

async function main() {
	const source = await prisma.paymentSource.findFirstOrThrow({
		where: { network: Network.Preprod, paymentSourceType: PaymentSourceType.Web3CardanoV2, deletedAt: null },
		include: { HotWallets: { where: { deletedAt: null }, include: { Secret: true } } },
	});
	const out: Record<string, { address: string; walletVkey: string }> = {};
	for (const type of [HotWalletType.Purchasing, HotWalletType.Selling]) {
		const wallet = source.HotWallets.find((w) => w.type === type);
		if (!wallet) throw new Error(`no ${type} hot wallet`);
		const mnemonic = decrypt(wallet.Secret.encryptedMnemonic).split(' ');
		const mw = generateOfflineWallet(source.network, mnemonic);
		const address = (await mw.getUnusedAddresses())[0] ?? mw.getUsedAddress().toBech32();
		out[type.toLowerCase()] = { address, walletVkey: wallet.walletVkey };
	}
	console.log(JSON.stringify(out, null, 2));
	await prisma.$disconnect();
	process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
