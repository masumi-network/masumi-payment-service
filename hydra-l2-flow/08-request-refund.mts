/**
 * Phase 8 — drive masumi's OWN L2 request-refund service (buyer side / RequestRefund)
 * against the live devnet. Advances the lock PurchaseRequest to the refund-request
 * state (onChainState=FundsLocked, nextAction=SetRefundRequestedRequested) and runs
 * requestRefundsV2(). The RequestRefund Plutus path executes IN-HEAD when spending
 * the FundsLocked script UTxO → produces a RefundRequested continuation.
 *
 * Requires a lock with a FUTURE unlockTime (vested_pay RequestRefund needs
 * must_end_before(validity_range, unlock_time)). Use 03-lock with default offsets.
 *
 * Run: DATABASE_URL=<test-db> HYDRA_L2_SLOT_* … pnpm exec tsx hydra-l2-flow/08-request-refund.mts
 */
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { requestRefundsV2 } from '@masumi/payment-source-v2/services/purchases/request-refund/service';

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
	console.log(`[req-refund] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

async function main() {
	const head = await prisma.hydraHead.findFirstOrThrow({
		include: { LocalParticipant: { include: { Wallet: { include: { Secret: true } } } } },
	});
	const purchase = await prisma.purchaseRequest.findFirstOrThrow({
		include: { NextAction: true, CurrentTransaction: true, SmartContractWallet: true },
	});
	log(`PurchaseRequest ${purchase.id} cur=${purchase.NextAction.requestedAction} txHash=${purchase.CurrentTransaction?.txHash?.slice(0, 16)}… unlockTime=${purchase.unlockTime}`);

	// REQUEST_REFUND_FROM_STATE=ResultSubmitted drives the FundsLocked path to
	// Disputed (result already submitted) instead of RefundRequested — used to set
	// up authorize-withdrawal. Default FundsLocked → RefundRequested.
	const fromResultSubmitted = process.env.REQUEST_REFUND_FROM_STATE === 'ResultSubmitted';
	const fromState = fromResultSubmitted ? OnChainState.ResultSubmitted : OnChainState.FundsLocked;
	// When starting from ResultSubmitted, the contract UTxO is at the submit-result
	// tx (06 left it on the seller PaymentRequest's CurrentTransaction), NOT the lock
	// tx the PurchaseRequest still points at. Repoint so the matcher fetches the
	// right (ResultSubmitted) UTxO.
	let currentTxConnect = {};
	if (fromResultSubmitted) {
		const payment = await prisma.paymentRequest.findFirstOrThrow({ include: { CurrentTransaction: true } });
		const submitTxHash = payment.CurrentTransaction!.txHash!;
		const submitTx = await prisma.transaction.create({
			data: {
				txHash: submitTxHash,
				status: TransactionStatus.Confirmed,
				layer: TransactionLayer.L2,
				HydraHead: { connect: { id: head.id } },
			},
		});
		currentTxConnect = { CurrentTransaction: { connect: { id: submitTx.id } } };
		log(`repointed PurchaseRequest CurrentTransaction → submit tx ${submitTxHash.slice(0, 16)}…`);
	}
	await prisma.purchaseRequest.update({
		where: { id: purchase.id },
		data: {
			onChainState: fromState,
			...currentTxConnect,
			NextAction: { update: { requestedAction: PurchasingAction.SetRefundRequestedRequested } },
		},
	});
	// SmartContractWallet on a PurchaseRequest is the buyer's local hot wallet.
	if (purchase.SmartContractWallet) {
		await prisma.hotWallet.update({
			where: { id: purchase.SmartContractWallet.id },
			data: { lockedAt: null, pendingTransactionId: null },
		});
	}
	log('advanced PurchaseRequest → SetRefundRequestedRequested / onChainState FundsLocked');

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

	log('calling requestRefundsV2()…');
	await requestRefundsV2();

	const after = await prisma.purchaseRequest.findUniqueOrThrow({
		where: { id: purchase.id },
		include: { NextAction: true, CurrentTransaction: true },
	});
	log(`post: nextAction=${after.NextAction.requestedAction} layer=${after.layer} txHash=${after.CurrentTransaction?.txHash?.slice(0, 16) ?? 'none'}…`);

	if (
		after.NextAction.requestedAction === PurchasingAction.SetRefundRequestedInitiated &&
		after.layer === TransactionLayer.L2
	) {
		log('=== L2 REQUEST-REFUND VIA MASUMI SERVICE: PASSED (RequestRefund executed in-head) ===');
	} else {
		log('=== L2 REQUEST-REFUND: did not complete as expected (see above) ===');
	}
	process.exit(0);
}

main().catch((e) => { console.error('[req-refund] FATAL', e); process.exit(1); });
