/**
 * Seed one payment node with the minimum needed to drive Hydra by hand.
 *
 * A payment source, one hot wallet, and an admin API key — nothing else. In
 * particular no relation and no connected Hydra node: a relation names the
 * *other* operator's wallet, which neither side knows until both exist, and
 * connecting the node is a step worth performing rather than pre-baking.
 *
 * Runs as its own process so DATABASE_URL is set before Prisma loads.
 *
 * Test support only.
 */

import { MeshWallet } from '@meshsdk/core';
import { ApiKeyStatus, HotWalletType, Network, PaymentSourceType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { generateApiKeySecureHash } from '@masumi/payment-core/api-key-hash';
import { encrypt } from '@/utils/security/encryption';
import { defaultV2ContractParams } from '@/utils/v2-contract-sync';

const LABEL = process.env.SEED_LABEL ?? 'node';
const BLOCKFROST_KEY = process.env.SEED_BLOCKFROST_KEY?.trim() ?? '';

async function ensureAdminApiKey(token: string): Promise<void> {
	const tokenHash = await generateApiKeySecureHash(token);
	await prisma.apiKey.upsert({
		where: { tokenHash },
		update: { status: ApiKeyStatus.Active },
		create: {
			token,
			tokenHash,
			status: ApiKeyStatus.Active,
			canRead: true,
			canPay: true,
			canAdmin: true,
			networkLimit: ['cardano:preprod'],
		},
	});
}

async function main(): Promise<void> {
	const v2Defaults = defaultV2ContractParams(Network.Preprod);
	if (v2Defaults === null) {
		throw new Error('no V2 contract defaults for Preprod');
	}

	// Explicit rather than relying on boot seeding: the service only seeds an
	// empty database, and this script has already written to it by then.
	await ensureAdminApiKey(process.env.ADMIN_KEY ?? '');

	const existing = await prisma.paymentSource.findFirst({
		where: { deletedAt: null },
		include: { HotWallets: { where: { deletedAt: null }, take: 1 } },
	});
	if (existing && existing.HotWallets.length > 0) {
		console.log(
			JSON.stringify({
				sourceId: existing.id,
				wallet: { id: existing.HotWallets[0].id, address: existing.HotWallets[0].walletAddress },
			}),
		);
		return;
	}

	const config = await prisma.paymentSourceConfig.create({
		// Plaintext, matching how the service reads it everywhere else. Encrypting
		// it here produced a source whose key could not be used.
		data: { rpcProviderApiKey: BLOCKFROST_KEY || 'unset', rpcProvider: 'Blockfrost' },
	});

	const adminWords = MeshWallet.brew() as string[];
	const admin = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: adminWords } });
	const adminAddress = await admin.getChangeAddress();

	// The admin-quorum trigger is DEFERRABLE INITIALLY DEFERRED, so the source and
	// its admin wallet only have to agree by commit time — but in one transaction.
	const source = await prisma.$transaction(async (tx) => {
		const created = await tx.paymentSource.create({
			data: {
				network: Network.Preprod,
				// The real deployed V2 contract and registry policy, not a
				// placeholder. A source with a made-up address and no policyId can
				// hold Hydra wallets but nothing else: every payment resolves its
				// source by (network, policyId) taken from the agent identifier, so
				// a null policyId fails every one of them with "Network and policyId
				// combination not supported".
				smartContractAddress: v2Defaults.smartContractAddress,
				policyId: v2Defaults.policyId,
				feeRatePermille: 50,
				cooldownTime: 0,
				paymentSourceType: PaymentSourceType.Web3CardanoV2,
				requiredAdminSignatures: 1,
				paymentSourceConfigId: config.id,
			},
		});
		await tx.adminWallet.create({
			data: { walletAddress: adminAddress, paymentSourceAdminId: created.id, order: 0 },
		});
		return created;
	});

	const words = MeshWallet.brew() as string[];
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words } });
	const address = await wallet.getChangeAddress();
	const { resolvePaymentKeyHash } = await import('@meshsdk/core');

	const secret = await prisma.walletSecret.create({ data: { encryptedMnemonic: encrypt(words.join(' ')) } });
	const hotWallet = await prisma.hotWallet.create({
		data: {
			walletVkey: resolvePaymentKeyHash(address),
			walletAddress: address,
			type: HotWalletType.Purchasing,
			secretId: secret.id,
			paymentSourceId: source.id,
			note: `${LABEL} wallet`,
		},
	});

	console.log(JSON.stringify({ sourceId: source.id, wallet: { id: hotWallet.id, address } }));
}

main()
	.then(async () => {
		await prisma.$disconnect();
		process.exit(0);
	})
	.catch(async (error: unknown) => {
		console.error((error as Error).stack ?? (error as Error).message);
		await prisma.$disconnect();
		process.exit(1);
	});
