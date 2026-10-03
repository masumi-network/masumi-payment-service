/**
 * Phase 7 — drive masumi's OWN L2 collection service (seller payout / CollectCompleted)
 * against the live devnet, continuing from the ResultSubmitted UTxO produced by
 * 06-submit-result. Advances the existing PaymentRequest to the collection-ready
 * state (onChainState=ResultSubmitted, nextAction=WithdrawRequested, resultHash
 * set), connects the CM, then calls collectOutstandingPaymentsV2(). The
 * CollectCompleted Plutus path executes IN-HEAD when spending the ResultSubmitted
 * UTxO.
 *
 * Requires the lock to have used a PAST unlockTime (UNLOCK_OFFSET_MS negative in
 * 03-lock) so collection variant A (ResultSubmitted + unlockTime elapsed) is open
 * immediately — vested_pay checks unlock_time only on the Withdraw spend, so a
 * past unlock_time + future submit_result_time is a valid contract.
 *
 * Run: DATABASE_URL=<test-db> HYDRA_L2_SLOT_* … pnpm exec tsx hydra-l2-flow/07-collection.mts
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { collectOutstandingPaymentsV2 } from '@masumi/payment-source-v2/services/payments/collection/service';

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
import { HydraHeadStatus, OnChainState, PaymentAction, TransactionLayer } from '@/generated/prisma/client';

function log(m: string) {
	console.log(`[collect] ${new Date().toISOString().slice(11, 19)} ${m}`);
}
const hex = (n: number) => randomBytes(n).toString('hex');

async function main() {
	const head = await prisma.hydraHead.findFirstOrThrow({
		include: { LocalParticipant: { include: { Wallet: { include: { Secret: true } } } } },
	});

	// The PaymentRequest produced by 06-submit-result (its CurrentTransaction.txHash
	// already points at the submit-result tx → the ResultSubmitted UTxO).
	const payment = await prisma.paymentRequest.findFirstOrThrow({
		include: { NextAction: true, CurrentTransaction: true, SmartContractWallet: true },
	});
	log(`PaymentRequest ${payment.id} cur=${payment.NextAction.requestedAction} txHash=${payment.CurrentTransaction?.txHash?.slice(0, 16)}… unlockTime=${payment.unlockTime}`);

	// Advance to collection-ready: onChainState=ResultSubmitted (the matcher checks
	// state == datum), nextAction=WithdrawRequested (the collection query filter),
	// resultHash non-null (query filter `resultHash: { not: null }`; not checked by
	// the matcher or the redeemer, so any non-null value is fine). Unlock the
	// seller wallet (a prior deferred op may have left lockedAt set).
	await prisma.paymentRequest.update({
		where: { id: payment.id },
		data: {
			onChainState: OnChainState.ResultSubmitted,
			resultHash: payment.resultHash ?? hex(32),
			NextAction: { update: { requestedAction: PaymentAction.WithdrawRequested } },
		},
	});
	await prisma.hotWallet.update({
		where: { id: payment.SmartContractWallet!.id },
		data: { lockedAt: null, pendingTransactionId: null },
	});
	log('advanced PaymentRequest → WithdrawRequested / onChainState ResultSubmitted');

	// Connect CM + mark head open.
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

	log('calling collectOutstandingPaymentsV2()…');
	await collectOutstandingPaymentsV2();

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

	if (
		after.NextAction.requestedAction === PaymentAction.WithdrawInitiated &&
		after.layer === TransactionLayer.L2
	) {
		log('=== L2 COLLECTION VIA MASUMI SERVICE: PASSED (CollectCompleted executed in-head) ===');
	} else {
		log('=== L2 COLLECTION: did not complete as expected (see above) ===');
	}
	process.exit(0);
}

main().catch((e) => { console.error('[collect] FATAL', e); process.exit(1); });
