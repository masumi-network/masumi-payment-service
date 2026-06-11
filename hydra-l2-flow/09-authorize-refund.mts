/**
 * Phase 9 — drive masumi's OWN L2 authorize-refund service (seller side /
 * AuthorizeRefund) against the live devnet. Creates a seller PaymentRequest that
 * tracks the RefundRequested contract produced by 08-request-refund
 * (CurrentTransaction.txHash = the request-refund tx), nextAction=
 * AuthorizeRefundRequested, then runs authorizeRefundV2(). The AuthorizeRefund
 * Plutus path executes IN-HEAD → produces a RefundAuthorized continuation.
 *
 * Run: DATABASE_URL=<test-db> HYDRA_L2_SLOT_* … pnpm exec tsx hydra-l2-flow/09-authorize-refund.mts
 */
import { readFileSync } from 'node:fs';
import { resolvePaymentKeyHash } from '@meshsdk/core';
import { prisma } from '@masumi/payment-core/db';
import { encrypt, decrypt } from '@/utils/security/encryption';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { authorizeRefundV2 } from '@masumi/payment-source-v2/services/payments/authorize-refund/service';

for (const lvl of ['info', 'warn', 'error'] as const) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const orig = (logger as any)[lvl].bind(logger);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(logger as any)[lvl] = (msg: string, meta?: any) => {
		if (meta && 'error' in meta) {
			const e = meta.error;
			console.error(`>>> ${lvl.toUpperCase()} ERROR DETAIL:`, e instanceof Error ? e.stack : JSON.stringify(e));
		}
		return orig(msg, meta);
	};
}
import {
	HydraHeadStatus,
	Network,
	OnChainState,
	PaymentAction,
	TransactionLayer,
	TransactionStatus,
	HotWalletType,
	WalletType,
} from '@/generated/prisma/client';

function log(m: string) {
	console.log(`[auth-refund] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

async function main() {
	const head = await prisma.hydraHead.findFirstOrThrow({
		include: {
			LocalParticipant: { include: { Wallet: { include: { Secret: true } } } },
			HydraRelation: { include: { RemoteWallet: true } },
		},
	});
	// The PurchaseRequest from 08 holds the RefundRequested tx in CurrentTransaction
	// plus all the datum-matching fields from the lock.
	const purchase = await prisma.purchaseRequest.findFirstOrThrow({
		include: { CurrentTransaction: true, PaidFunds: true },
	});
	const refundTxHash = purchase.CurrentTransaction!.txHash!;
	const paymentSourceId = purchase.paymentSourceId;
	const apiKey = await prisma.apiKey.findFirstOrThrow();
	log(`RefundRequested tx=${refundTxHash.slice(0, 16)}… bid=${purchase.blockchainIdentifier.slice(0, 20)}…`);

	// Buyer address/vkey (must match the on-chain datum the lock wrote).
	const buyerMnemonic = decrypt(head.LocalParticipant!.Wallet.Secret.encryptedMnemonic).split(' ');
	const buyerOffline = generateOfflineWallet(Network.Preprod, buyerMnemonic);
	const buyerAddress = (await buyerOffline.getUnusedAddresses())[0];
	const buyerVkey = resolvePaymentKeyHash(buyerAddress);

	// Seller Selling hot wallet (from .seller.json or recovered from DB).
	let sellerMnemonic: string[];
	try {
		sellerMnemonic = (JSON.parse(readFileSync('hydra-l2-flow/.seller.json', 'utf-8')) as { mnemonic: string[] }).mnemonic;
	} catch {
		const ex = await prisma.hotWallet.findFirstOrThrow({
			where: { walletVkey: head.HydraRelation.RemoteWallet.walletVkey, type: HotWalletType.Selling },
			include: { Secret: true },
		});
		sellerMnemonic = decrypt(ex.Secret.encryptedMnemonic).split(' ');
	}
	const sellerAddress = (await generateOfflineWallet(Network.Preprod, sellerMnemonic).getUnusedAddresses())[0];
	const sellerVkey = resolvePaymentKeyHash(sellerAddress);
	let sellerHot = await prisma.hotWallet.findFirst({ where: { walletVkey: sellerVkey } });
	if (!sellerHot) {
		sellerHot = await prisma.hotWallet.create({
			data: {
				walletVkey: sellerVkey,
				walletAddress: sellerAddress,
				type: HotWalletType.Selling,
				collectionAddress: sellerAddress,
				PaymentSource: { connect: { id: paymentSourceId } },
				Secret: { create: { encryptedMnemonic: encrypt(sellerMnemonic.join(' ')) } },
			},
		});
	}
	await prisma.hotWallet.update({ where: { id: sellerHot.id }, data: { lockedAt: null, pendingTransactionId: null } });

	// Clean prior payment requests; create a fresh seller PaymentRequest tracking
	// the RefundRequested UTxO at refundTxHash, ready for authorize-refund.
	const prior = await prisma.paymentRequest.findMany({ select: { id: true } });
	for (const p of prior) await prisma.unitValue.deleteMany({ where: { paymentRequestId: p.id } });
	await prisma.paymentRequest.deleteMany({});

	const paymentTx = await prisma.transaction.create({
		data: { txHash: refundTxHash, status: TransactionStatus.Confirmed, layer: TransactionLayer.L2, HydraHead: { connect: { id: head.id } } },
	});
	const buyerWallet = await prisma.walletBase.upsert({
		where: { paymentSourceId_walletVkey_walletAddress_type: { paymentSourceId, walletVkey: buyerVkey, walletAddress: buyerAddress, type: WalletType.Buyer } },
		create: { walletVkey: buyerVkey, walletAddress: buyerAddress, type: WalletType.Buyer, paymentSourceId },
		update: {},
	});
	const payment = await prisma.paymentRequest.create({
		data: {
			PaymentSource: { connect: { id: paymentSourceId } },
			requestedBy: { connect: { id: apiKey.id } },
			blockchainIdentifier: purchase.blockchainIdentifier,
			inputHash: purchase.inputHash,
			submitResultTime: purchase.submitResultTime,
			unlockTime: purchase.unlockTime,
			externalDisputeUnlockTime: purchase.externalDisputeUnlockTime,
			sellerCoolDownTime: 0n,
			buyerCoolDownTime: 0n,
			payByTime: purchase.payByTime,
			collateralReturnLovelace: 0n,
			onChainState: OnChainState.RefundRequested,
			layer: TransactionLayer.L2,
			SmartContractWallet: { connect: { id: sellerHot.id } },
			BuyerWallet: { connect: { id: buyerWallet.id } },
			CurrentTransaction: { connect: { id: paymentTx.id } },
			RequestedFunds: { create: purchase.PaidFunds.map((f) => ({ unit: f.unit, amount: f.amount })) },
			NextAction: { create: { requestedAction: PaymentAction.AuthorizeRefundRequested } },
		},
		include: { NextAction: true },
	});
	log(`PaymentRequest ${payment.id} AuthorizeRefundRequested / onChainState RefundRequested`);

	await prisma.hydraHead.update({ where: { id: head.id }, data: { status: HydraHeadStatus.Open, isEnabled: true } });
	const cm = getHydraConnectionManager();
	await cm.connect({
		id: head.id,
		LocalParticipant: {
			walletId: head.LocalParticipant!.walletId,
			nodeHttpUrl: head.LocalParticipant!.nodeHttpUrl,
			nodeUrl: head.LocalParticipant!.nodeUrl,
		},
	});
	await new Promise((r) => setTimeout(r, 800));

	log('calling authorizeRefundV2()…');
	await authorizeRefundV2();

	const after = await prisma.paymentRequest.findUniqueOrThrow({
		where: { id: payment.id },
		include: { NextAction: true, CurrentTransaction: true },
	});
	log(`post: nextAction=${after.NextAction.requestedAction} layer=${after.layer} txHash=${after.CurrentTransaction?.txHash?.slice(0, 16) ?? 'none'}…`);

	if (after.NextAction.requestedAction === PaymentAction.AuthorizeRefundInitiated && after.layer === TransactionLayer.L2) {
		log('=== L2 AUTHORIZE-REFUND VIA MASUMI SERVICE: PASSED (AuthorizeRefund executed in-head) ===');
	} else {
		log('=== L2 AUTHORIZE-REFUND: did not complete as expected (see above) ===');
	}
	process.exit(0);
}

main().catch((e) => { console.error('[auth-refund] FATAL', e); process.exit(1); });
