/**
 * Seed the HydraHead DB row for the LIVE preprod bench pair (nodes on
 * 4001/4002, purchasing/selling keys from hydra-l2-flow/preprod/). Adapted
 * from preprod-seed-hydra-db.mts, which targeted the 4101/4102 recovery pair.
 *
 * Run: DATABASE_URL=<test-db> pnpm exec tsx hydra-l2-flow/seed-head-row.mts
 */
import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@masumi/payment-core/db';
import { encrypt } from '@/utils/security/encryption';
import { deriveNodeCardanoVkey } from '@/services/hydra-invite/node-keys';
import { HotWalletType, Network, PaymentSourceType, WalletType } from '@/generated/prisma/client';

const PREPROD_DIR = join(process.cwd(), 'hydra-l2-flow/preprod');
const LOCAL_WS_URL = process.env.HYDRA_LOCAL_WS ?? 'ws://127.0.0.1:4001';
const LOCAL_HTTP_URL = process.env.HYDRA_LOCAL_HTTP ?? 'http://127.0.0.1:4001';
const REMOTE_WS_URL = process.env.HYDRA_REMOTE_WS ?? 'ws://127.0.0.1:4002';
const REMOTE_HTTP_URL = process.env.HYDRA_REMOTE_HTTP ?? 'http://127.0.0.1:4002';

function readCborHex(name: string): string {
	const envelope = JSON.parse(readFileSync(join(PREPROD_DIR, name), 'utf8')) as { cborHex: string };
	if (!envelope.cborHex) throw new Error(`${name} has no cborHex`);
	return envelope.cborHex;
}

async function main() {
	const paymentSource = await prisma.paymentSource.findFirstOrThrow({
		where: { network: Network.Preprod, paymentSourceType: PaymentSourceType.Web3CardanoV2, deletedAt: null },
		include: {
			HotWallets: {
				where: { type: { in: [HotWalletType.Purchasing, HotWalletType.Selling] }, deletedAt: null },
			},
		},
	});
	const purchasingWallet = paymentSource.HotWallets.find((w) => w.type === HotWalletType.Purchasing);
	const sellingWallet = paymentSource.HotWallets.find((w) => w.type === HotWalletType.Selling);
	if (!purchasingWallet || !sellingWallet) throw new Error('missing V2 preprod hot wallets');

	const remoteWallet = await prisma.walletBase.upsert({
		where: {
			paymentSourceId_walletVkey_walletAddress_type: {
				paymentSourceId: paymentSource.id,
				walletVkey: sellingWallet.walletVkey,
				walletAddress: sellingWallet.walletAddress,
				type: WalletType.Seller,
			},
		},
		create: {
			paymentSourceId: paymentSource.id,
			walletVkey: sellingWallet.walletVkey,
			walletAddress: sellingWallet.walletAddress,
			type: WalletType.Seller,
			note: 'Hydra preprod bench remote seller wallet',
		},
		update: {},
	});

	const hydraRelation = await prisma.hydraRelation.upsert({
		where: {
			network_localHotWalletId_remoteWalletId: {
				network: Network.Preprod,
				localHotWalletId: purchasingWallet.id,
				remoteWalletId: remoteWallet.id,
			},
		},
		create: { network: Network.Preprod, localHotWalletId: purchasingWallet.id, remoteWalletId: remoteWallet.id },
		update: {},
	});

	const existing = await prisma.hydraHead.findFirst({
		where: { hydraRelationId: hydraRelation.id, isEnabled: true },
		orderBy: { createdAt: 'desc' },
	});
	if (existing) {
		console.log(JSON.stringify({ reused: true, hydraHeadId: existing.id }));
		await prisma.$disconnect();
		process.exit(0);
	}

	// Clean partial rows from any earlier failed attempt (head-less participants).
	await prisma.hydraLocalParticipant.deleteMany({ where: { hydraHeadId: null } });
	await prisma.hydraRemoteParticipant.deleteMany({ where: { hydraHeadId: null } });
	const hydraHost =
		(await prisma.hydraHost.findFirst({ where: { name: 'local-bench-mac' } })) ??
		(await prisma.hydraHost.create({
			data: {
				name: 'local-bench-mac',
				network: Network.Preprod,
				baseUrl: LOCAL_HTTP_URL,
				allowInsecureHttp: true,
				publicPeerHost: '127.0.0.1',
				encryptedUserToken: encrypt('local-bench'),
			},
		}));
	const localParticipant = await prisma.hydraLocalParticipant.create({
		data: {
			Wallet: { connect: { id: purchasingWallet.id } },
			nodeUrl: LOCAL_WS_URL,
			nodeHttpUrl: LOCAL_HTTP_URL,
			cardanoVkey: deriveNodeCardanoVkey(readCborHex('purchasing-cardano.vk')),
			HydraHost: { connect: { id: hydraHost.id } },
			hostNodeId: '1',
			HydraSecretKey: { create: { hydraSK: encrypt(readCborHex('purchasing-hydra.sk')) } },
		},
	});
	const remoteParticipant = await prisma.hydraRemoteParticipant.create({
		data: {
			Wallet: { connect: { id: remoteWallet.id } },
			cardanoVkey: deriveNodeCardanoVkey(readCborHex('selling-cardano.vk')),
			advertise: '127.0.0.1:5002',
			HydraVerificationKey: { create: { hydraVK: readCborHex('selling-hydra.vk') } },
		},
	});
	const head = await prisma.hydraHead.create({
		data: {
			HydraRelation: { connect: { id: hydraRelation.id } },
			contestationPeriod: 220n,
			LocalParticipant: { connect: { id: localParticipant.id } },
			RemoteParticipants: { connect: [{ id: remoteParticipant.id }] },
		},
	});
	console.log(JSON.stringify({ reused: false, hydraHeadId: head.id, localParticipantId: localParticipant.id }));
	await prisma.$disconnect();
	// Explicit exit: prisma keeps handles open, so without this the process
	// hangs and any caller capturing its output waits forever.
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
