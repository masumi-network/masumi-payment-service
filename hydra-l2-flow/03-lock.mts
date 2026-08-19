/**
 * Phase 4+5 — drive masumi's OWN L2 funds-lock service against the live devnet.
 *
 * Same process for all of: mark head Open, connect the connection manager,
 * create a FundsLockingRequested PurchaseRequest, then call
 * processL2PurchaseLocks(). The CM is a singleton, so the lock finds the
 * provider we connected here. Verifies the FundsLocked datum lands in the head
 * at the V2 smart-contract address.
 *
 * Run: DATABASE_URL=<test-db> pnpm exec tsx hydra-l2-flow/03-lock.mts
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@masumi/payment-core/db';
import { generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { processL2PurchaseLocks } from '@masumi/payment-source-v2/services/purchases/batch-payments/l2-lock';
import { HydraHeadStatus, PurchasingAction } from '@/generated/prisma/client';

// Surface the real error the lock's catch swallows (winston drops the `error` key).
const _origWarn = logger.warn.bind(logger);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(logger as any).warn = (msg: string, meta?: any) => {
	if (meta && 'error' in meta) {
		console.error('>>> LOCK ERROR DETAIL:', meta.error instanceof Error ? meta.error.stack : meta.error);
	}
	return _origWarn(msg, meta);
};

const HEAD_NODE_IDENTIFIER = process.env.HEAD_IDENTIFIER ?? '33f8e10a2a5e1f6e2276cf279eb4bc2f4a9e7442de5b7fb943a4ff67';
const LOCK_LOVELACE = process.env.LOCK_LOVELACE ?? '40000000';

function log(m: string) {
	console.log(`[lock] ${new Date().toISOString().slice(11, 19)} ${m}`);
}
const hex = (n: number) => randomBytes(n).toString('hex');

async function main() {
	// ── Resolve seeded entities ───────────────────────────────────────────────
	const head = await prisma.hydraHead.findFirstOrThrow({
		include: {
			LocalParticipant: { include: { Wallet: { include: { PaymentSource: true } } } },
			HydraRelation: { include: { RemoteWallet: true } },
		},
	});
	const buyerWallet = head.LocalParticipant!.Wallet;
	const paymentSource = buyerWallet.PaymentSource;
	const sellerWallet = head.HydraRelation.RemoteWallet;
	const apiKey = await prisma.apiKey.findFirstOrThrow();

	log(`head=${head.id} buyerWallet=${buyerWallet.id} seller=${sellerWallet.id} source=${paymentSource.id}`);
	log(`smartContractAddress=${paymentSource.smartContractAddress}`);

	// ── Mark the head Open + give it the on-chain identifier ──────────────────
	await prisma.hydraHead.update({
		where: { id: head.id },
		data: { status: HydraHeadStatus.Open, isEnabled: true, headIdentifier: HEAD_NODE_IDENTIFIER, openedAt: new Date() },
	});
	log('head marked Open');

	// ── Connect the connection manager to the head (singleton) ────────────────
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
	const provider = cm.getProvider(head.id);
	log(`CM connected; provider present=${!!provider}`);
	if (!provider) throw new Error('connection manager has no provider for the head');

	const buyerInHead = await provider.fetchAddressUTxOs(
		// buyer address derived below via wallet session inside the lock; here just
		// snapshot the whole head for visibility
		(await provider.fetchUTxOs()).find(() => true)?.output.address ?? '',
	);
	void buyerInHead;
	const snapshot = await provider.fetchUTxOs();
	log(`in-head UTxOs: ${snapshot.length}`);

	// ── Clean up any prior purchase requests (deterministic reruns) ───────────
	const prior = await prisma.purchaseRequest.findMany({ select: { id: true, nextActionId: true } });
	for (const p of prior) {
		await prisma.unitValue.deleteMany({ where: { purchaseRequestId: p.id } });
		await prisma.transaction.deleteMany({ where: { PurchaseRequestCurrent: { some: { id: p.id } } } }).catch(() => undefined);
	}
	await prisma.purchaseRequest.deleteMany({});
	await prisma.purchaseActionData.deleteMany({});
	log(`cleaned up ${prior.length} prior purchase request(s)`);

	// ── Create a FundsLockingRequested PurchaseRequest ────────────────────────
	// Include the smartContractAddress as the 5th segment so the value round-trips
	// through the on-chain datum: decodeV2ContractDatum reconstructs the
	// identifier WITH the script address appended, and submit-result's matcher
	// compares the reconstructed identifier against this stored one.
	const blockchainIdentifier = generateBlockchainIdentifier(hex(28), hex(28), hex(32), hex(32), paymentSource.smartContractAddress);
	// Anchor the datum times to the DEVNET slot clock (zeroTime + currentSlot*slotLen)
	// when the HYDRA_L2 slot env is set, NOT wallclock. The devnet slot clock drifts
	// behind wallclock, so a wallclock-relative "past unlock" would otherwise map to a
	// FUTURE devnet slot (the L2 services convert datum times → slots via the same
	// slot context), inverting the collection validity window. On a real preprod head
	// (no env) this falls back to Date.now(), which matches the head's slot clock.
	const slotZero = process.env.HYDRA_L2_SLOT_ZERO_TIME_MS;
	const slotLen = process.env.HYDRA_L2_SLOT_LENGTH_MS;
	const curSlot = process.env.HYDRA_L2_CURRENT_SLOT;
	const now =
		slotZero && slotLen && curSlot ? Number(slotZero) + Number(curSlot) * Number(slotLen) : Date.now();
	// Time offsets (ms) are env-overridable so flow variants can craft contracts
	// whose per-action bounds open immediately. vested_pay checks each bound only
	// on its own spend (submit-result→submit_result_time, collection→unlock_time),
	// so e.g. UNLOCK_OFFSET_MS can be NEGATIVE (unlock already past → collection is
	// valid now) while SUBMIT_RESULT_OFFSET_MS stays positive (submit still valid).
	const off = (k: string, d: number) => Number(process.env[k] ?? d);
	const submitResultOffsetMs = off('SUBMIT_RESULT_OFFSET_MS', 30 * 60 * 1000);
	const unlockOffsetMs = off('UNLOCK_OFFSET_MS', 60 * 60 * 1000);
	const disputeOffsetMs = off('DISPUTE_OFFSET_MS', 90 * 60 * 1000);
	const payByOffsetMs = off('PAYBY_OFFSET_MS', 10 * 60 * 1000);
	const purchase = await prisma.purchaseRequest.create({
		data: {
			PaymentSource: { connect: { id: paymentSource.id } },
			SellerWallet: { connect: { id: sellerWallet.id } },
			requestedBy: { connect: { id: apiKey.id } },
			blockchainIdentifier,
			inputHash: hex(16),
			submitResultTime: BigInt(now + submitResultOffsetMs),
			unlockTime: BigInt(now + unlockOffsetMs),
			externalDisputeUnlockTime: BigInt(now + disputeOffsetMs),
			sellerCoolDownTime: 0n,
			buyerCoolDownTime: 0n,
			payByTime: BigInt(now + payByOffsetMs),
			sellerReturnAddress: sellerWallet.walletAddress,
			buyerReturnAddress: process.env.MASUMI_ADDR ?? null,
			isLimitedToHotWallets: false,
			PaidFunds: { create: [{ unit: '', amount: BigInt(LOCK_LOVELACE) }] },
			NextAction: { create: { requestedAction: PurchasingAction.FundsLockingRequested } },
		},
		include: { NextAction: true, PaidFunds: true },
	});
	log(`created PurchaseRequest ${purchase.id} (FundsLockingRequested, ${LOCK_LOVELACE} lovelace)`);

	// ── Drive the masumi L2 lock service ──────────────────────────────────────
	log('calling processL2PurchaseLocks()…');
	await processL2PurchaseLocks();

	// ── Verify ────────────────────────────────────────────────────────────────
	const after = await prisma.purchaseRequest.findUniqueOrThrow({
		where: { id: purchase.id },
		include: { NextAction: true, CurrentTransaction: true },
	});
	log(`post-lock: nextAction=${after.NextAction.requestedAction} layer=${after.layer} txHash=${after.CurrentTransaction?.txHash ?? 'none'}`);

	const postSnapshot = await provider.fetchUTxOs();
	const scriptUtxos = postSnapshot.filter((u) => u.output.address === paymentSource.smartContractAddress);
	log(`in-head UTxOs at smart-contract address: ${scriptUtxos.length}`);
	for (const u of scriptUtxos) {
		const ada = u.output.amount.find((a) => a.unit === 'lovelace')?.quantity;
		log(`  ${u.input.txHash.slice(0, 16)}…#${u.input.outputIndex} ${ada} lovelace datum=${u.output.plutusData ? 'present' : 'MISSING'}`);
	}

	if (scriptUtxos.length > 0 && after.NextAction.requestedAction === PurchasingAction.FundsLockingInitiated) {
		log('=== L2 FUNDS-LOCK VIA MASUMI SERVICE: PASSED ===');
	} else {
		log('=== L2 FUNDS-LOCK: did not complete as expected (see above) ===');
	}
	process.exit(0);
}

main().catch((e) => { console.error('[lock] FATAL', e); process.exit(1); });
