/**
 * Seed the minimum fixtures for exercising the cross-org head handshake
 * locally: one payment source, a local hot wallet, a counterparty wallet whose
 * mnemonic we keep so we can sign *as* the counterparty, a relation between
 * them, and a registered Hydra Host.
 *
 * Test-support only. Prints the ids and the counterparty mnemonic so the
 * driver script can play the other operator.
 */

import { MeshWallet } from '@meshsdk/core';
import { HydraHostStatus, HotWalletType, Network, PaymentSourceType, WalletType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { encrypt } from '@/utils/security/encryption';

const HOST_BASE_URL = process.env.FIXTURE_HOST_URL ?? 'http://127.0.0.1:18443';
const HOST_ADMIN_TOKEN = process.env.FIXTURE_HOST_ADMIN_TOKEN ?? '';
const HOST_USER_TOKEN = process.env.FIXTURE_HOST_USER_TOKEN ?? '';
const COUNTERPARTY_BASE_URL = process.env.FIXTURE_COUNTERPARTY_URL ?? 'http://127.0.0.1:3011';

async function walletFrom(words: string[]): Promise<{ address: string; vkey: string }> {
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words } });
	const address = await wallet.getChangeAddress();
	const { resolvePaymentKeyHash } = await import('@meshsdk/core');
	return { address, vkey: resolvePaymentKeyHash(address) };
}

async function main(): Promise<void> {
	const config = await prisma.paymentSourceConfig.create({
		data: { rpcProviderApiKey: encrypt('fixture'), rpcProvider: 'Blockfrost' },
	});
	const adminWords = MeshWallet.brew() as string[];
	const admin = await walletFrom(adminWords);

	// The admin-quorum trigger is DEFERRABLE INITIALLY DEFERRED, so the source and
	// its admin wallet only have to agree by commit time — but they must be in the
	// same transaction.
	const source = await prisma.$transaction(async (tx) => {
		const created = await tx.paymentSource.create({
			data: {
				network: Network.Preprod,
				smartContractAddress: `addr_test1fixture${Date.now()}`,
				feeRatePermille: 50,
				cooldownTime: 0,
				// Hydra heads are a V2 concern, and the V1 constraint wants a single
				// admin wallet while V2 wants a quorum.
				paymentSourceType: PaymentSourceType.Web3CardanoV2,
				requiredAdminSignatures: 1,
				paymentSourceConfigId: config.id,
			},
		});
		await tx.adminWallet.create({
			data: { walletAddress: admin.address, paymentSourceAdminId: created.id, order: 0 },
		});
		return created;
	});

	const localWords = MeshWallet.brew() as string[];
	const remoteWords = MeshWallet.brew() as string[];
	const local = await walletFrom(localWords);
	const remote = await walletFrom(remoteWords);

	const secret = await prisma.walletSecret.create({
		data: { encryptedMnemonic: encrypt(localWords.join(' ')) },
	});
	const localWallet = await prisma.hotWallet.create({
		data: {
			walletVkey: local.vkey,
			walletAddress: local.address,
			type: HotWalletType.Purchasing,
			secretId: secret.id,
			paymentSourceId: source.id,
		},
	});
	const remoteWallet = await prisma.walletBase.create({
		data: {
			walletVkey: remote.vkey,
			walletAddress: remote.address,
			type: WalletType.Seller,
			paymentSourceId: source.id,
		},
	});

	const relation = await prisma.hydraRelation.create({
		data: {
			network: Network.Preprod,
			localHotWalletId: localWallet.id,
			remoteWalletId: remoteWallet.id,
			counterpartyBaseUrl: COUNTERPARTY_BASE_URL,
		},
	});

	// Idempotent: re-running the fixture must not trip the (network, baseUrl)
	// uniqueness that stops one host being registered twice.
	const host = await prisma.hydraHost.upsert({
		where: { network_baseUrl: { network: Network.Preprod, baseUrl: HOST_BASE_URL } },
		update: {},
		create: {
			name: 'fixture-host',
			network: Network.Preprod,
			baseUrl: HOST_BASE_URL,
			publicPeerHost: 'hydra-smoke.local',
			encryptedUserToken: encrypt(HOST_USER_TOKEN),
			encryptedAdminToken: HOST_ADMIN_TOKEN.length > 0 ? encrypt(HOST_ADMIN_TOKEN) : null,
			status: HydraHostStatus.Active,
		},
	});

	// The initiator is decided by key order, so report which side this instance
	// is — the driver needs to know whether to propose or to expect an offer.
	const weInitiate = local.vkey < remote.vkey;

	console.log(
		JSON.stringify(
			{
				relationId: relation.id,
				hostId: host.id,
				localVkey: local.vkey,
				localAddress: local.address,
				remoteVkey: remote.vkey,
				remoteAddress: remote.address,
				remoteMnemonic: remoteWords.join(' '),
				weInitiate,
			},
			null,
			2,
		),
	);
}

main()
	.then(async () => {
		await prisma.$disconnect();
		process.exit(0);
	})
	.catch(async (error: unknown) => {
		console.error((error as Error).message);
		await prisma.$disconnect();
		process.exit(1);
	});
