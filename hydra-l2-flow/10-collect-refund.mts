/**
 * Phase 10 — drive masumi's OWN L2 collect-refund service (buyer side /
 * CollectRefund withdraw) against the live devnet. Points the buyer PurchaseRequest
 * at the RefundAuthorized contract produced by 09-authorize-refund and runs
 * collectRefundV2(). The CollectRefund Plutus path executes IN-HEAD when spending
 * the RefundAuthorized UTxO → the buyer's funds return to the buyer refund address.
 *
 * Run: DATABASE_URL=<test-db> HYDRA_L2_SLOT_* … pnpm exec tsx hydra-l2-flow/10-collect-refund.mts
 */
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { collectRefundV2 } from '@masumi/payment-source-v2/services/purchases/collect-refund/service';

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
import { HydraHeadStatus, OnChainState, PurchasingAction, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

function log(m: string) {
	console.log(`[collect-refund] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

async function main() {
	const head = await prisma.hydraHead.findFirstOrThrow({
		include: { LocalParticipant: { include: { Wallet: { include: { Secret: true } } } } },
	});
	// The RefundAuthorized UTxO lives at the authorize-refund tx (tracked by the
	// seller PaymentRequest from phase 9).
	const payment = await prisma.paymentRequest.findFirstOrThrow({ include: { CurrentTransaction: true } });
	const authorizeTxHash = payment.CurrentTransaction!.txHash!;
	const purchase = await prisma.purchaseRequest.findFirstOrThrow({
		include: { NextAction: true, CurrentTransaction: true, SmartContractWallet: true },
	});
	log(`RefundAuthorized tx=${authorizeTxHash.slice(0, 16)}… purchase=${purchase.id} cur=${purchase.NextAction.requestedAction}`);

	// Repoint the buyer PurchaseRequest at the RefundAuthorized UTxO and arm
	// collect-refund.
	const newTx = await prisma.transaction.create({
		data: { txHash: authorizeTxHash, status: TransactionStatus.Confirmed, layer: TransactionLayer.L2, HydraHead: { connect: { id: head.id } } },
	});
	await prisma.purchaseRequest.update({
		where: { id: purchase.id },
		data: {
			onChainState: OnChainState.RefundAuthorized,
			CurrentTransaction: { connect: { id: newTx.id } },
			NextAction: { update: { requestedAction: PurchasingAction.WithdrawRefundRequested } },
		},
	});
	if (purchase.SmartContractWallet) {
		await prisma.hotWallet.update({
			where: { id: purchase.SmartContractWallet.id },
			data: { lockedAt: null, pendingTransactionId: null },
		});
	}
	log('advanced PurchaseRequest → WithdrawRefundRequested / onChainState RefundAuthorized');

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

	log('calling collectRefundV2()…');
	await collectRefundV2();

	const after = await prisma.purchaseRequest.findUniqueOrThrow({
		where: { id: purchase.id },
		include: { NextAction: true, CurrentTransaction: true },
	});
	log(`post: nextAction=${after.NextAction.requestedAction} layer=${after.layer} txHash=${after.CurrentTransaction?.txHash?.slice(0, 16) ?? 'none'}…`);

	const snap = await provider.fetchUTxOs();
	const scriptUtxos = snap.filter((u) => u.output.plutusData);
	log(`script UTxOs in head: ${scriptUtxos.length}`);

	if (after.NextAction.requestedAction === PurchasingAction.WithdrawRefundInitiated && after.layer === TransactionLayer.L2) {
		log('=== L2 COLLECT-REFUND VIA MASUMI SERVICE: PASSED (CollectRefund executed in-head) ===');
	} else {
		log('=== L2 COLLECT-REFUND: did not complete as expected (see above) ===');
	}
	process.exit(0);
}

main().catch((e) => { console.error('[collect-refund] FATAL', e); process.exit(1); });
