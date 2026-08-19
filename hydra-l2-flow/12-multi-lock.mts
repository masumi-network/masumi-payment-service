/**
 * Multi-in-one-tick test — create N (default 2) FundsLockingRequested
 * PurchaseRequests and run processL2PurchaseLocks() ONCE. The L2 lock pre-pass
 * loops over every FundsLockingRequested request for the head, so a single
 * orchestrator tick should lock all N escrows (each as its own in-head tx).
 * Demonstrates the L2 orchestrator handling multiple escrows per tick — the L2
 * equivalent of L1 batching (L2 stays single-item-per-tx by design: in-head txs
 * are free + instant, so there's no fee reason to batch).
 *
 * Run: DATABASE_URL=<test-db> HYDRA_L2_SLOT_* N=2 LOCK_LOVELACE=3500000 \
 *      pnpm exec tsx hydra-l2-flow/12-multi-lock.mts
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@masumi/payment-core/db';
import { generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { processL2PurchaseLocks } from '@masumi/payment-source-v2/services/purchases/batch-payments/l2-lock';
import { HydraHeadStatus, PurchasingAction } from '@/generated/prisma/client';

const _origWarn = logger.warn.bind(logger);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(logger as any).warn = (msg: string, meta?: any) => {
	if (meta && 'error' in meta) console.error('>>> LOCK ERROR DETAIL:', meta.error instanceof Error ? meta.error.stack : meta.error);
	return _origWarn(msg, meta);
};

const HEAD_NODE_IDENTIFIER = process.env.HEAD_IDENTIFIER ?? '33f8e10a2a5e1f6e2276cf279eb4bc2f4a9e7442de5b7fb943a4ff67';
const LOCK_LOVELACE = process.env.LOCK_LOVELACE ?? '3500000';
const N = Number(process.env.N ?? 2);
const hex = (n: number) => randomBytes(n).toString('hex');
function log(m: string) { console.log(`[multi-lock] ${new Date().toISOString().slice(11, 19)} ${m}`); }

async function main() {
	const head = await prisma.hydraHead.findFirstOrThrow({
		include: {
			LocalParticipant: { include: { Wallet: { include: { PaymentSource: true } } } },
			HydraRelation: { include: { RemoteWallet: true } },
		},
	});
	const paymentSource = head.LocalParticipant!.Wallet.PaymentSource;
	const sellerWallet = head.HydraRelation.RemoteWallet;
	const apiKey = await prisma.apiKey.findFirstOrThrow();

	await prisma.hydraHead.update({ where: { id: head.id }, data: { status: HydraHeadStatus.Open, isEnabled: true, headIdentifier: HEAD_NODE_IDENTIFIER, openedAt: new Date() } });
	const cm = getHydraConnectionManager();
	await cm.connect({ id: head.id, LocalParticipant: { walletId: head.LocalParticipant!.walletId, nodeHttpUrl: head.LocalParticipant!.nodeHttpUrl, nodeUrl: head.LocalParticipant!.nodeUrl } });
	await new Promise((r) => setTimeout(r, 800));
	const provider = cm.getProvider(head.id)!;

	// Clean prior purchase requests.
	const prior = await prisma.purchaseRequest.findMany({ select: { id: true } });
	for (const p of prior) {
		await prisma.unitValue.deleteMany({ where: { purchaseRequestId: p.id } });
		await prisma.transaction.deleteMany({ where: { PurchaseRequestCurrent: { some: { id: p.id } } } }).catch(() => undefined);
	}
	await prisma.purchaseRequest.deleteMany({});
	await prisma.purchaseActionData.deleteMany({});

	const slotZero = process.env.HYDRA_L2_SLOT_ZERO_TIME_MS;
	const slotLen = process.env.HYDRA_L2_SLOT_LENGTH_MS;
	const curSlot = process.env.HYDRA_L2_CURRENT_SLOT;
	const now = slotZero && slotLen && curSlot ? Number(slotZero) + Number(curSlot) * Number(slotLen) : Date.now();

	const ids: string[] = [];
	for (let i = 0; i < N; i++) {
		const bid = generateBlockchainIdentifier(hex(28), hex(28), hex(32), hex(32), paymentSource.smartContractAddress);
		const p = await prisma.purchaseRequest.create({
			data: {
				PaymentSource: { connect: { id: paymentSource.id } },
				SellerWallet: { connect: { id: sellerWallet.id } },
				requestedBy: { connect: { id: apiKey.id } },
				blockchainIdentifier: bid,
				inputHash: hex(16),
				submitResultTime: BigInt(now + 30 * 60 * 1000),
				unlockTime: BigInt(now + 60 * 60 * 1000),
				externalDisputeUnlockTime: BigInt(now + 90 * 60 * 1000),
				sellerCoolDownTime: 0n,
				buyerCoolDownTime: 0n,
				payByTime: BigInt(now + 10 * 60 * 1000),
				sellerReturnAddress: sellerWallet.walletAddress,
				buyerReturnAddress: null,
				isLimitedToHotWallets: false,
				PaidFunds: { create: [{ unit: '', amount: BigInt(LOCK_LOVELACE) }] },
				NextAction: { create: { requestedAction: PurchasingAction.FundsLockingRequested } },
			},
		});
		ids.push(p.id);
	}
	log(`created ${N} FundsLockingRequested PurchaseRequests (${LOCK_LOVELACE} lovelace each)`);

	const scriptBefore = (await provider.fetchUTxOs()).filter((u) => u.output.plutusData).length;
	log(`calling processL2PurchaseLocks() ONCE for ${N} requests…`);
	await processL2PurchaseLocks();

	const after = await prisma.purchaseRequest.findMany({ where: { id: { in: ids } }, include: { NextAction: true, CurrentTransaction: true } });
	const locked = after.filter((r) => r.NextAction.requestedAction === PurchasingAction.FundsLockingInitiated && r.layer === 'L2');
	for (const r of after) log(`  request ${r.id.slice(0, 10)} → ${r.NextAction.requestedAction} layer=${r.layer} tx=${r.CurrentTransaction?.txHash?.slice(0, 12) ?? 'none'}`);
	const scriptAfter = (await provider.fetchUTxOs()).filter((u) => u.output.plutusData).length;
	log(`script UTxOs in head: ${scriptBefore} → ${scriptAfter} (+${scriptAfter - scriptBefore})`);

	if (locked.length === N && scriptAfter - scriptBefore === N) {
		log(`=== L2 MULTI-LOCK IN ONE TICK: PASSED (${N}/${N} escrows locked in a single orchestrator tick) ===`);
	} else {
		log(`=== L2 MULTI-LOCK: ${locked.length}/${N} locked, +${scriptAfter - scriptBefore} script UTxOs — see above ===`);
	}
	process.exit(0);
}

main().catch((e) => { console.error('[multi-lock] FATAL', e); process.exit(1); });
