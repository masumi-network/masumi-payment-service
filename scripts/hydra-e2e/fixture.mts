/**
 * Seeds the end-to-end database and prints the ids as JSON.
 *
 * Runs as its own process so `DATABASE_URL` is set before Prisma loads.
 *
 * Two relations are created, not one, and their wallet keys are chosen rather
 * than left to chance: the initiator is decided by key order, so a relation
 * where we sort lower exercises the outbound path and one where we sort higher
 * exercises the inbound path. With random keys only one of the two would be
 * testable per run, at random.
 *
 * Test support only.
 */

import { MeshWallet } from '@meshsdk/core';
import {
	ApiKeyStatus,
	HotWalletType,
	HydraHostStatus,
	Network,
	PaymentSourceType,
	WalletType,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { generateApiKeySecureHash } from '@masumi/payment-core/api-key-hash';
import { encrypt } from '@/utils/security/encryption';

const HOST_BASE_URL = process.env.FIXTURE_HOST_URL ?? '';
const HOST_ADMIN_TOKEN = process.env.FIXTURE_HOST_ADMIN_TOKEN ?? '';
const HOST_USER_TOKEN = process.env.FIXTURE_HOST_USER_TOKEN ?? '';
const HOST_PUBLIC_PEER_HOST = process.env.FIXTURE_HOST_PUBLIC_PEER_HOST ?? '127.0.0.1';
const COUNTERPARTY_BASE_URL = process.env.FIXTURE_COUNTERPARTY_URL ?? 'http://127.0.0.1:3011';

type Party = { words: string[]; address: string; vkey: string };

async function brew(): Promise<Party> {
	const words = MeshWallet.brew() as string[];
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words } });
	const address = await wallet.getChangeAddress();
	const { resolvePaymentKeyHash } = await import('@meshsdk/core');
	return { words, address, vkey: resolvePaymentKeyHash(address) };
}

/**
 * A pair whose key order puts us on the side we want to test.
 *
 * `localSortsLower` true makes us the initiator for that relation.
 */
async function pairWhere(localSortsLower: boolean): Promise<{ local: Party; remote: Party }> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const [local, remote] = await Promise.all([brew(), brew()]);
		if (local.vkey === remote.vkey) {
			continue;
		}
		if (local.vkey < remote.vkey === localSortsLower) {
			return { local, remote };
		}
	}
	throw new Error('could not brew a wallet pair with the required key order');
}

/**
 * Create the admin API key explicitly rather than relying on boot seeding.
 *
 * The service only seeds when the database is empty, and this fixture has
 * already written to it — so by the time the service starts, seeding is
 * skipped and the admin key would not exist.
 */
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
	await ensureAdminApiKey(process.env.ADMIN_KEY ?? '');

	// A real Blockfrost key when one is offered, so wallet balances resolve and
	// the admin UI is usable by hand; a placeholder is fine for the assertions.
	const config = await prisma.paymentSourceConfig.create({
		data: {
			rpcProviderApiKey: encrypt(process.env.FIXTURE_BLOCKFROST_KEY?.trim() || 'fixture'),
			rpcProvider: 'Blockfrost',
		},
	});
	const admin = await brew();

	// The admin-quorum trigger is DEFERRABLE INITIALLY DEFERRED, so the source
	// and its admin wallet only have to agree by commit time — but they must be
	// in the same transaction.
	const source = await prisma.$transaction(async (tx) => {
		const created = await tx.paymentSource.create({
			data: {
				network: Network.Preprod,
				smartContractAddress: `addr_test1hydrae2e${Date.now()}`,
				feeRatePermille: 50,
				cooldownTime: 0,
				// Hydra heads are a V2 concern; the V1 constraint wants a single admin
				// wallet while V2 wants a quorum.
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

	async function makeRelation(label: string, localSortsLower: boolean, walletType: HotWalletType) {
		const { local, remote } = await pairWhere(localSortsLower);
		const secret = await prisma.walletSecret.create({
			data: { encryptedMnemonic: encrypt(local.words.join(' ')) },
		});
		const localWallet = await prisma.hotWallet.create({
			data: {
				walletVkey: local.vkey,
				walletAddress: local.address,
				type: walletType,
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
				// Named, because the counterparty picker falls back to the bare type
				// when there is no note — and several unnamed "Seller" rows are
				// indistinguishable in a dropdown.
				note: `counterparty (${label})`,
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
		return {
			label,
			relationId: relation.id,
			weInitiate: localSortsLower,
			localAddress: local.address,
			remoteAddress: remote.address,
			// The counterparty's mnemonic, so the harness can sign *as them*.
			remoteMnemonic: remote.words.join(' '),
		};
	}

	// Typed by the role the relation actually puts us in: we propose on the
	// outbound one (buyer) and answer on the inbound one (seller). Seeding both as
	// Purchasing made the wallet list read as two buying wallets for no reason.
	const outbound = await makeRelation('outbound', true, HotWalletType.Purchasing);
	// Only the assertions need the acceptor side — it cannot be driven by hand,
	// because a counterparty has to send the offer.
	const inbound =
		process.env.FIXTURE_RELATIONS === 'outbound' ? null : await makeRelation('inbound', false, HotWalletType.Selling);

	const host = await prisma.hydraHost.upsert({
		where: { network_baseUrl: { network: Network.Preprod, baseUrl: HOST_BASE_URL } },
		update: { status: HydraHostStatus.Active },
		create: {
			name: 'e2e-host',
			network: Network.Preprod,
			baseUrl: HOST_BASE_URL,
			publicPeerHost: HOST_PUBLIC_PEER_HOST,
			encryptedUserToken: encrypt(HOST_USER_TOKEN),
			encryptedAdminToken: HOST_ADMIN_TOKEN.length > 0 ? encrypt(HOST_ADMIN_TOKEN) : null,
			status: HydraHostStatus.Active,
		},
	});

	console.log(JSON.stringify({ sourceId: source.id, hostId: host.id, outbound, inbound }));
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
