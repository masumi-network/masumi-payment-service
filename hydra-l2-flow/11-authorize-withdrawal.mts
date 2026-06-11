/**
 * Phase 11 — drive masumi's OWN L2 authorize-withdrawal service (buyer side /
 * AuthorizeWithdrawal) against the live devnet. The buyer concedes a disputed
 * escrow: the contract must be Disputed (reach it via submit-result then
 * request-refund with REQUEST_REFUND_FROM_STATE=ResultSubmitted). Advances the
 * buyer PurchaseRequest to AuthorizeWithdrawalRequested and runs
 * authorizeWithdrawalsV2(). The AuthorizeWithdrawal Plutus path executes IN-HEAD
 * → produces a WithdrawAuthorized continuation (which collection variant B can
 * then pay out).
 *
 * Run: DATABASE_URL=<test-db> HYDRA_L2_SLOT_* … pnpm exec tsx hydra-l2-flow/11-authorize-withdrawal.mts
 */
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { authorizeWithdrawalsV2 } from '@masumi/payment-source-v2/services/purchases/authorize-withdrawal/service';

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
import { HydraHeadStatus, OnChainState, PurchasingAction, TransactionLayer } from '@/generated/prisma/client';

function log(m: string) {
	console.log(`[auth-wd] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

async function main() {
	const head = await prisma.hydraHead.findFirstOrThrow({
		include: { LocalParticipant: { include: { Wallet: { include: { Secret: true } } } } },
	});
	const purchase = await prisma.purchaseRequest.findFirstOrThrow({
		include: { NextAction: true, CurrentTransaction: true, SmartContractWallet: true },
	});
	log(`PurchaseRequest ${purchase.id} cur=${purchase.NextAction.requestedAction} txHash=${purchase.CurrentTransaction?.txHash?.slice(0, 16)}…`);

	await prisma.purchaseRequest.update({
		where: { id: purchase.id },
		data: {
			onChainState: OnChainState.Disputed,
			NextAction: { update: { requestedAction: PurchasingAction.AuthorizeWithdrawalRequested } },
		},
	});
	if (purchase.SmartContractWallet) {
		await prisma.hotWallet.update({
			where: { id: purchase.SmartContractWallet.id },
			data: { lockedAt: null, pendingTransactionId: null },
		});
	}
	log('advanced PurchaseRequest → AuthorizeWithdrawalRequested / onChainState Disputed');

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

	log('calling authorizeWithdrawalsV2()…');
	await authorizeWithdrawalsV2();

	const after = await prisma.purchaseRequest.findUniqueOrThrow({
		where: { id: purchase.id },
		include: { NextAction: true, CurrentTransaction: true },
	});
	log(`post: nextAction=${after.NextAction.requestedAction} layer=${after.layer} txHash=${after.CurrentTransaction?.txHash?.slice(0, 16) ?? 'none'}…`);

	if (after.NextAction.requestedAction === PurchasingAction.AuthorizeWithdrawalInitiated && after.layer === TransactionLayer.L2) {
		log('=== L2 AUTHORIZE-WITHDRAWAL VIA MASUMI SERVICE: PASSED (AuthorizeWithdrawal executed in-head) ===');
	} else {
		log('=== L2 AUTHORIZE-WITHDRAWAL: did not complete as expected (see above) ===');
	}
	process.exit(0);
}

main().catch((e) => { console.error('[auth-wd] FATAL', e); process.exit(1); });
