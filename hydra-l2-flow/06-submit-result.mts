/**
 * Phase 6 — drive masumi's OWN L2 submit-result service (seller side) against
 * the live devnet. Sets up the seller (Selling HotWallet from .seller.json),
 * a PaymentRequest (SubmitResultRequested, L2, FundsLocked) tied to the lock
 * tx, connects the CM, then calls submitResultV2(). The V2 Plutus validator
 * executes IN-HEAD when spending the locked script UTxO — the deepest check.
 *
 * Run: DATABASE_URL=<test-db> pnpm exec tsx hydra-l2-flow/06-submit-result.mts
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolvePaymentKeyHash } from '@meshsdk/core';
import { prisma } from '@masumi/payment-core/db';
import { encrypt } from '@/utils/security/encryption';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { submitResultV2 } from '@masumi/payment-source-v2/services/payments/submit-result/service';

// Surface the error the orchestrator logs (winston drops the `error` key).
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
	console.log(`[submit] ${new Date().toISOString().slice(11, 19)} ${m}`);
}
const hex = (n: number) => randomBytes(n).toString('hex');

async function main() {
	const head = await prisma.hydraHead.findFirstOrThrow({
		include: {
			LocalParticipant: { include: { Wallet: { include: { Secret: true } } } },
			HydraRelation: { include: { RemoteWallet: true } },
		},
	});
	const { decrypt: decryptSecret } = await import('@/utils/security/encryption');
	// Seller mnemonic: prefer .seller.json (first run); else recover it from the
	// already-created seller Selling hot wallet's encrypted secret in the DB.
	let seller: { mnemonic: string[] };
	try {
		seller = JSON.parse(readFileSync('hydra-l2-flow/.seller.json', 'utf-8')) as { mnemonic: string[] };
	} catch {
		const existingSeller = await prisma.hotWallet.findFirstOrThrow({
			where: { walletVkey: head.HydraRelation.RemoteWallet.walletVkey, type: HotWalletType.Selling },
			include: { Secret: true },
		});
		seller = { mnemonic: decryptSecret(existingSeller.Secret.encryptedMnemonic).split(' ') };
	}
	// Derive the buyer's real address + vkey (must match the on-chain datum the
	// lock wrote, or findMatchingUtxoAndDecodeContract rejects the script UTxO).
	const { decrypt } = await import('@/utils/security/encryption');
	const buyerMnemonic = decrypt(head.LocalParticipant!.Wallet.Secret.encryptedMnemonic).split(' ');
	const buyerOffline = generateOfflineWallet(Network.Preprod, buyerMnemonic);
	const buyerAddress = (await buyerOffline.getUnusedAddresses())[0];
	const buyerVkeyReal = resolvePaymentKeyHash(buyerAddress);
	const lockedPurchase = await prisma.purchaseRequest.findFirstOrThrow({
		include: { CurrentTransaction: true, PaidFunds: true },
	});
	const paymentSourceId = lockedPurchase.paymentSourceId;
	const apiKey = await prisma.apiKey.findFirstOrThrow();
	const lockTxHash = lockedPurchase.CurrentTransaction!.txHash!;
	log(`lock tx=${lockTxHash} head=${head.id} bid=${lockedPurchase.blockchainIdentifier.slice(0, 24)}…`);

	// ── Seller Selling HotWallet (from .seller.json) ──────────────────────────
	const sellerWalletAddress = (await generateOfflineWallet(Network.Preprod, seller.mnemonic).getUnusedAddresses())[0];
	const sellerVkey = resolvePaymentKeyHash(sellerWalletAddress);
	let sellerHot = await prisma.hotWallet.findFirst({ where: { walletVkey: sellerVkey } });
	if (!sellerHot) {
		sellerHot = await prisma.hotWallet.create({
			data: {
				walletVkey: sellerVkey,
				walletAddress: sellerWalletAddress,
				type: HotWalletType.Selling,
				collectionAddress: sellerWalletAddress,
				PaymentSource: { connect: { id: paymentSourceId } },
				Secret: { create: { encryptedMnemonic: encrypt(seller.mnemonic.join(' ')) } },
			},
		});
	}
	log(`seller Selling hot wallet=${sellerHot.id} addr=${sellerWalletAddress.slice(0, 24)}…`);

	// ── Clean up prior payment requests + unlock wallets (deterministic reruns)
	const prior = await prisma.paymentRequest.findMany({ select: { id: true } });
	for (const p of prior) await prisma.unitValue.deleteMany({ where: { paymentRequestId: p.id } });
	await prisma.paymentRequest.deleteMany({});
	await prisma.paymentActionData.deleteMany({ where: { PaymentRequestCurrent: { isNot: null } } }).catch(() => undefined);
	// lockAndQueryPayments sets lockedAt on the Selling wallet; a deferred submit
	// leaves it locked, so unlock before re-driving.
	await prisma.hotWallet.update({ where: { id: sellerHot.id }, data: { lockedAt: null, pendingTransactionId: null } });

	// ── CurrentTransaction for the payment side (references the lock tx) ───────
	const paymentTx = await prisma.transaction.create({
		data: {
			txHash: lockTxHash,
			status: TransactionStatus.Confirmed,
			layer: TransactionLayer.L2,
			HydraHead: { connect: { id: head.id } },
		},
	});

	// ── PaymentRequest: SubmitResultRequested, L2, FundsLocked ────────────────
	const resultHash = hex(32);
	const buyerWallet = await prisma.walletBase.upsert({
		where: {
			paymentSourceId_walletVkey_walletAddress_type: {
				paymentSourceId,
				walletVkey: buyerVkeyReal,
				walletAddress: buyerAddress,
				type: WalletType.Buyer,
			},
		},
		create: { walletVkey: buyerVkeyReal, walletAddress: buyerAddress, type: WalletType.Buyer, paymentSourceId },
		update: {},
	});
	const payment = await prisma.paymentRequest.create({
		data: {
			PaymentSource: { connect: { id: paymentSourceId } },
			requestedBy: { connect: { id: apiKey.id } },
			blockchainIdentifier: lockedPurchase.blockchainIdentifier,
			inputHash: lockedPurchase.inputHash,
			submitResultTime: lockedPurchase.submitResultTime,
			unlockTime: lockedPurchase.unlockTime,
			externalDisputeUnlockTime: lockedPurchase.externalDisputeUnlockTime,
			sellerCoolDownTime: 0n,
			buyerCoolDownTime: 0n,
			payByTime: lockedPurchase.payByTime,
			collateralReturnLovelace: 0n,
			onChainState: OnChainState.FundsLocked,
			layer: TransactionLayer.L2,
			SmartContractWallet: { connect: { id: sellerHot.id } },
			BuyerWallet: { connect: { id: buyerWallet.id } },
			CurrentTransaction: { connect: { id: paymentTx.id } },
			RequestedFunds: { create: lockedPurchase.PaidFunds.map((f) => ({ unit: f.unit, amount: f.amount })) },
			NextAction: { create: { requestedAction: PaymentAction.SubmitResultRequested, resultHash } },
		},
		include: { NextAction: true },
	});
	log(`PaymentRequest ${payment.id} SubmitResultRequested resultHash=${resultHash.slice(0, 16)}…`);

	// ── Connect CM (singleton) + mark head open ───────────────────────────────
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
	const provider = cm.getProvider(head.id)!;

	// ── Drive submit-result ───────────────────────────────────────────────────
	log('calling submitResultV2()…');
	await submitResultV2();

	// ── Verify ────────────────────────────────────────────────────────────────
	const after = await prisma.paymentRequest.findUniqueOrThrow({
		where: { id: payment.id },
		include: { NextAction: true, CurrentTransaction: true },
	});
	log(`post: nextAction=${after.NextAction.requestedAction} layer=${after.layer} txHash=${after.CurrentTransaction?.txHash?.slice(0, 16) ?? 'none'}…`);

	const snap = await provider.fetchUTxOs();
	const scriptUtxos = snap.filter((u) => u.output.plutusData);
	log(`script UTxOs in head: ${scriptUtxos.length}`);
	for (const u of scriptUtxos) {
		const ada = u.output.amount.find((a) => a.unit === 'lovelace')?.quantity;
		log(`  ${u.input.txHash.slice(0, 16)}…#${u.input.outputIndex} ${ada} lovelace`);
	}

	if (after.NextAction.requestedAction === PaymentAction.SubmitResultInitiated) {
		log('=== L2 SUBMIT-RESULT VIA MASUMI SERVICE: PASSED (Plutus validator executed in-head) ===');
	} else {
		log('=== L2 SUBMIT-RESULT: did not complete as expected (see above) ===');
	}
	process.exit(0);
}

main().catch((e) => { console.error('[submit] FATAL', e); process.exit(1); });
