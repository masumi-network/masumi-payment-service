/**
 * Masumi escrow e2e TPS bench — N FULL V2 escrow lifecycles (lock →
 * submit-result → collect) driven through masumi's OWN services against the
 * LIVE preprod Hydra head. Every transaction is built, signed and submitted by
 * the same code the production crons run:
 *
 *   lock    : processL2PurchaseLocks()        (@masumi/payment-source-v2)
 *   submit  : submitResultV2()                — Plutus validator runs in-head
 *   collect : collectOutstandingPaymentsV2()  — Plutus validator runs in-head
 *
 * Fixture shapes are copied from the proven flow scripts (12-multi-lock,
 * 06-submit-result, 07-collection): unlockTime is set in the PAST so the
 * Withdraw path is open as soon as the post-submit cooldown elapses
 * (vested_pay checks unlock_time only on the Withdraw spend).
 *
 * Reported numbers:
 *   - locks/sec, submits/sec, collects/sec  (one service call each, N txs)
 *   - cooldown wait between submit and collect (contract parameter, not infra)
 *   - lifecycles/sec including and excluding the cooldown
 *
 * Preconditions: preprod head OPEN, test DB seeded (seed-head-row.mts), buyer
 * (purchasing hot wallet address) funded in-head with ≥ N×LOCK+5 ADA, seller
 * (selling hot wallet address) funded in-head (~20 ADA).
 *
 * Run:
 *   DATABASE_URL=<test-db> pnpm exec tsx hydra-l2-flow/bench-escrow-e2e.mts [N]
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { cpus, arch, platform } from 'node:os';
import { join } from 'node:path';

const N = Number(process.argv[2] ?? '10');
const LOCK_LOVELACE = BigInt(process.env.LOCK_LOVELACE ?? '4000000');
const NODE1_LOG = join(process.cwd(), 'hydra-l2-flow', '.native-state', 'node1.log');
const NODE1_HTTP = process.env.HYDRA_NODE1_HTTP ?? 'http://127.0.0.1:4001';
const PREPROD_SLOT_ZERO_MS = 1655683200000;

function log(m: string) {
	console.log(`[escrow-bench] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

/** The head validates against its OWN observed slot — read the last Tick. */
function headSlotFromLog(): number | null {
	// Tail only: this log reaches hundreds of MB, and this runs every tick.
	// Widen the window if a quiet moment leaves no slot in the last chunk.
	for (const windowBytes of [256 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024]) {
		try {
			const fd = openSync(NODE1_LOG, 'r');
			try {
				const size = fstatSync(fd).size;
				const len = Math.min(size, windowBytes);
				const buf = Buffer.alloc(len);
				readSync(fd, buf, 0, len, size - len);
				const matches = buf.toString('utf-8').match(/"slot":(\d+)/g);
				if (matches && matches.length > 0) {
					return Number(matches[matches.length - 1].match(/(\d+)/)![1]);
				}
			} finally {
				closeSync(fd);
			}
		} catch {
			/* try a wider window */
		}
	}
	return null;
}

// Slot context must be in env BEFORE the services are imported/called.
const headSlot = headSlotFromLog();
if (!headSlot) {
	console.error('[escrow-bench] could not read head Tick slot from node1.log — is the preprod node up (verbose)?');
	process.exit(2);
}
process.env.HYDRA_L2_SLOT_ZERO_TIME_MS = String(PREPROD_SLOT_ZERO_MS);
process.env.HYDRA_L2_SLOT_LENGTH_MS = '1000';
process.env.HYDRA_L2_CURRENT_SLOT = String(headSlot);

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { decrypt } from '@/utils/security/encryption';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { resolvePaymentKeyHash } from '@meshsdk/core';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { processL2PurchaseLocks } from '@masumi/payment-source-v2/services/purchases/batch-payments/l2-lock';
import { submitResultV2 } from '@masumi/payment-source-v2/services/payments/submit-result/service';
import { collectOutstandingPaymentsV2 } from '@masumi/payment-source-v2/services/payments/collection/service';
import {
	HydraHeadStatus,
	Network,
	OnChainState,
	PaymentAction,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
	HotWalletType,
	WalletType,
} from '@/generated/prisma/client';

const hex = (n: number) => randomBytes(n).toString('hex');

// Surface the error detail the services log (winston drops the `error` key).
for (const lvl of ['warn', 'error'] as const) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const orig = (logger as any)[lvl].bind(logger);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(logger as any)[lvl] = (msg: string, meta?: any) => {
		if (meta && 'error' in meta) {
			const e = meta.error;
			console.error(`>>> ${lvl.toUpperCase()}:`, msg, '|', e instanceof Error ? e.message : JSON.stringify(e)?.slice(0, 300));
		}
		return orig(msg, meta);
	};
}

async function inHeadLovelace(address: string): Promise<bigint> {
	const res = await fetch(`${NODE1_HTTP}/snapshot/utxo`);
	const utxos = (await res.json()) as Record<string, { address: string; value: { lovelace: number } }>;
	return Object.values(utxos)
		.filter((u) => u.address === address)
		.reduce((s, u) => s + BigInt(u.value.lovelace), 0n);
}

async function scriptUtxoCount(): Promise<number> {
	const res = await fetch(`${NODE1_HTTP}/snapshot/utxo`);
	const utxos = (await res.json()) as Record<string, { inlineDatum?: unknown }>;
	return Object.values(utxos).filter((u) => u.inlineDatum != null).length;
}

async function unlockWallets() {
	await prisma.hotWallet.updateMany({ data: { lockedAt: null, pendingTransactionId: null } });
}

async function main() {
	const nowMs = PREPROD_SLOT_ZERO_MS + headSlot! * 1000;
	log(`head slot ${headSlot} → head time ${new Date(nowMs).toISOString()} (wall ${new Date().toISOString()})`);

	const head = await prisma.hydraHead.findFirstOrThrow({
		include: {
			LocalParticipant: { include: { Wallet: { include: { Secret: true, PaymentSource: true } } } },
			HydraRelation: { include: { RemoteWallet: true } },
		},
	});
	const paymentSource = head.LocalParticipant!.Wallet.PaymentSource;
	const remoteWallet = head.HydraRelation.RemoteWallet;
	const apiKey = await prisma.apiKey.findFirstOrThrow();

	// Buyer address (purchasing hot wallet mnemonic — the datum's buyer vkey).
	const buyerMnemonic = decrypt(head.LocalParticipant!.Wallet.Secret.encryptedMnemonic).split(' ');
	const buyerOffline = generateOfflineWallet(Network.Preprod, buyerMnemonic);
	const buyerAddress = (await buyerOffline.getUnusedAddresses())[0];
	const buyerVkey = resolvePaymentKeyHash(buyerAddress);

	// Seller Selling hot wallet (seeded; vkey matches the head's remote wallet).
	const sellerHot = await prisma.hotWallet.findFirstOrThrow({
		where: { walletVkey: remoteWallet.walletVkey, type: HotWalletType.Selling },
	});

	// Funding preflight — fail fast with the fix, not five minutes in.
	const buyerFunds = await inHeadLovelace(buyerAddress);
	const sellerFunds = await inHeadLovelace(sellerHot.walletAddress);
	const needed = LOCK_LOVELACE * BigInt(N) + 5_000_000n;
	log(`in-head: buyer ${buyerFunds} (need ${needed}), seller ${sellerFunds}`);
	if (buyerFunds < needed) {
		throw new Error(`buyer ${buyerAddress} needs ${needed} lovelace in-head — run 02-fund-in-head.mts first`);
	}
	if (sellerFunds < 5_000_000n) {
		throw new Error(`seller ${sellerHot.walletAddress} needs ~20 ADA in-head — run 02-fund-in-head.mts first`);
	}

	// Deterministic reruns: clear prior requests, unlock wallets.
	const priorP = await prisma.purchaseRequest.findMany({ select: { id: true } });
	for (const p of priorP) await prisma.unitValue.deleteMany({ where: { purchaseRequestId: p.id } });
	const priorPay = await prisma.paymentRequest.findMany({ select: { id: true } });
	for (const p of priorPay) await prisma.unitValue.deleteMany({ where: { paymentRequestId: p.id } });
	await prisma.paymentRequest.deleteMany({});
	await prisma.purchaseRequest.deleteMany({});
	await unlockWallets();

	await prisma.hydraHead.update({
		where: { id: head.id },
		data: { status: HydraHeadStatus.Open, isEnabled: true, openedAt: head.openedAt ?? new Date() },
	});
	const cm = getHydraConnectionManager();
	await cm.connect({
		id: head.id,
		LocalParticipant: {
			walletId: head.LocalParticipant!.walletId,
			nodeHttpUrl: head.LocalParticipant!.nodeHttpUrl,
			nodeUrl: head.LocalParticipant!.nodeUrl,
		},
	});
	await new Promise((r) => setTimeout(r, 1000));

	// ── Phase A: N locks in one service tick ──────────────────────────────────
	const ids: string[] = [];
	for (let i = 0; i < N; i++) {
		const bid = generateBlockchainIdentifier(hex(28), hex(28), hex(32), hex(32), paymentSource.smartContractAddress);
		const p = await prisma.purchaseRequest.create({
			data: {
				PaymentSource: { connect: { id: paymentSource.id } },
				SellerWallet: { connect: { id: remoteWallet.id } },
				requestedBy: { connect: { id: apiKey.id } },
				blockchainIdentifier: bid,
				inputHash: hex(16),
				submitResultTime: BigInt(nowMs + 30 * 60 * 1000),
				// PAST unlock: Withdraw is gated only by unlock_time on its own
				// spend, so collection opens right after the post-submit cooldown.
				unlockTime: BigInt(nowMs - 10 * 60 * 1000),
				externalDisputeUnlockTime: BigInt(nowMs + 90 * 60 * 1000),
				sellerCoolDownTime: 0n,
				buyerCoolDownTime: 0n,
				payByTime: BigInt(nowMs + 10 * 60 * 1000),
				sellerReturnAddress: remoteWallet.walletAddress,
				buyerReturnAddress: null,
				isLimitedToHotWallets: false,
				PaidFunds: { create: [{ unit: '', amount: LOCK_LOVELACE }] },
				NextAction: { create: { requestedAction: PurchasingAction.FundsLockingRequested } },
			},
		});
		ids.push(p.id);
	}
	const scriptsBefore = await scriptUtxoCount();
	log(`Phase A: ${N} FundsLockingRequested created — looping processL2PurchaseLocks()…`);
	// One lock per tick: each lock tx marks the hot wallet pending, so the
	// service (correctly) defers the rest to the next cron tick. Loop the tick.
	const tA0 = performance.now();
	let lockedCount = 0;
	let lockStalls = 0;
	for (let tick = 0; tick < N * 3 + 10; tick++) {
		// Re-read the head's observed slot every tick: a stale slot context puts
		// the tx validity window in the head's past (OutsideValidityIntervalUTxO).
		process.env.HYDRA_L2_CURRENT_SLOT = String(headSlotFromLog() ?? headSlot);
		// A tick can throw on a transient serializable write conflict; that is a
		// retryable stall, not the end of the run.
		await processL2PurchaseLocks().catch((e) => {
			log(`  lock tick error (retrying): ${e instanceof Error ? e.message.slice(0, 90) : String(e)}`);
		});
		await unlockWallets();
		// Count anything PAST the request state: the service advances a locked
		// escrow from FundsLockingInitiated on to WaitingForExternalAction once
		// the in-head tx confirms, so counting only the former undercounts badly.
		const done = await prisma.purchaseRequest.count({
			where: {
				id: { in: ids },
				NextAction: { requestedAction: { not: PurchasingAction.FundsLockingRequested } },
			},
		});
		if (done === N) { lockedCount = done; break; }
		// Tolerate a few no-progress ticks before concluding it is stuck.
		lockStalls = done === lockedCount ? lockStalls + 1 : 0;
		lockedCount = done;
		if (lockStalls >= 3) break;
	}
	const tA1 = performance.now();
	const lockedRequests = await prisma.purchaseRequest.findMany({
		where: { id: { in: ids } },
		include: { NextAction: true, CurrentTransaction: true },
	});
	const locked = lockedRequests.filter(
		(r) =>
			r.NextAction.requestedAction !== PurchasingAction.FundsLockingRequested &&
			r.CurrentTransaction?.txHash != null,
	);
	const scriptsAfterLock = await scriptUtxoCount();
	const lockSec = (tA1 - tA0) / 1000;
	log(`Phase A done: ${locked.length}/${N} locked in ${lockSec.toFixed(1)}s (${(locked.length / lockSec).toFixed(2)}/s), script UTxOs ${scriptsBefore}→${scriptsAfterLock}`);
	if (locked.length === 0) throw new Error('no locks succeeded — aborting');

	// ── Phase B fixtures: payment side per locked escrow ──────────────────────
	const buyerWallet = await prisma.walletBase.upsert({
		where: {
			paymentSourceId_walletVkey_walletAddress_type: {
				paymentSourceId: paymentSource.id,
				walletVkey: buyerVkey,
				walletAddress: buyerAddress,
				type: WalletType.Buyer,
			},
		},
		create: { walletVkey: buyerVkey, walletAddress: buyerAddress, type: WalletType.Buyer, paymentSourceId: paymentSource.id },
		update: {},
	});
	const paymentIds: string[] = [];
	for (const purchase of locked) {
		const paymentTx = await prisma.transaction.create({
			data: {
				txHash: purchase.CurrentTransaction!.txHash!,
				status: TransactionStatus.Confirmed,
				layer: TransactionLayer.L2,
				HydraHead: { connect: { id: head.id } },
			},
		});
		const payment = await prisma.paymentRequest.create({
			data: {
				PaymentSource: { connect: { id: paymentSource.id } },
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
				onChainState: OnChainState.FundsLocked,
				layer: TransactionLayer.L2,
				SmartContractWallet: { connect: { id: sellerHot.id } },
				BuyerWallet: { connect: { id: buyerWallet.id } },
				CurrentTransaction: { connect: { id: paymentTx.id } },
				RequestedFunds: { create: [{ unit: '', amount: LOCK_LOVELACE }] },
				NextAction: { create: { requestedAction: PaymentAction.SubmitResultRequested, resultHash: hex(32) } },
			},
		});
		paymentIds.push(payment.id);
	}
	await unlockWallets();
	log(`Phase B: ${paymentIds.length} SubmitResultRequested created — looping submitResultV2()…`);
	const tB0 = performance.now();
	let submittedCount = 0;
	let submitStalls = 0;
	for (let tick = 0; tick < N * 3 + 10; tick++) {
		process.env.HYDRA_L2_CURRENT_SLOT = String(headSlotFromLog() ?? headSlot);
		await submitResultV2().catch((e) => {
			log(`  submit tick error (retrying): ${e instanceof Error ? e.message.slice(0, 90) : String(e)}`);
		});
		await unlockWallets();
		// Count anything PAST the request state — NOT the transient
		// SubmitResultInitiated. The connection manager's live WS listener
		// advances a confirmed submit on to WaitingForExternalAction within
		// milliseconds, so an exact match on *Initiated races that listener and
		// undercounts (potentially to zero) on a perfectly healthy run. Same
		// correction as Phase A above.
		const done = await prisma.paymentRequest.count({
			where: {
				id: { in: paymentIds },
				NextAction: { requestedAction: { not: PaymentAction.SubmitResultRequested } },
				// AND require a real transaction: "moved past Requested" alone would
				// also count a permanently failed payment as a success.
				CurrentTransaction: { txHash: { not: null } },
			},
		});
		if (done === paymentIds.length) { submittedCount = done; break; }
		submitStalls = done === submittedCount ? submitStalls + 1 : 0;
		submittedCount = done;
		if (submitStalls >= 3) break;
	}
	const tB1 = performance.now();
	const submitted = await prisma.paymentRequest.findMany({
		where: {
			id: { in: paymentIds },
			NextAction: { requestedAction: { not: PaymentAction.SubmitResultRequested } },
			CurrentTransaction: { txHash: { not: null } },
		},
		include: { NextAction: true },
	});
	const submitSec = (tB1 - tB0) / 1000;
	log(`Phase B done: ${submitted.length}/${paymentIds.length} submitted in ${submitSec.toFixed(1)}s (${(submitted.length / submitSec).toFixed(2)}/s)`);
	if (submitted.length === 0) throw new Error('no submits succeeded — aborting');

	// ── Phase C: collects, retried across the on-chain datum cooldown ─────────
	// The submit-result tx writes the seller cooldown INTO THE DATUM (derived
	// from the tx window's upper bound + PaymentSource.cooldownTime). The
	// collect matcher silently skips escrows still cooling down, so we retry on
	// an interval and split the timing into cooldown-wait vs active collecting.
	for (const id of paymentIds) {
		await prisma.paymentRequest.update({
			where: { id },
			data: {
				onChainState: OnChainState.ResultSubmitted,
				resultHash: hex(32),
				NextAction: { update: { requestedAction: PaymentAction.WithdrawRequested } },
			},
		}).catch(() => undefined);
	}
	await unlockWallets();
	log(`Phase C: looping collectOutstandingPaymentsV2() until the datum cooldown opens…`);
	const tC0 = performance.now();
	let firstCollectAt: number | null = null;
	let collectedCount = 0;
	const collectDeadline = performance.now() + 25 * 60 * 1000;
	while (performance.now() < collectDeadline) {
		process.env.HYDRA_L2_CURRENT_SLOT = String(headSlotFromLog() ?? headSlot);
		await collectOutstandingPaymentsV2();
		await unlockWallets();
		// As in Phase B: count anything past WithdrawRequested. A confirmed
		// withdrawal is advanced off WithdrawInitiated (to None) by the live WS
		// listener within milliseconds, so exact-matching the transient state
		// undercounts and can leave this loop spinning until its 25-minute
		// deadline while the work has in fact completed.
		const done = await prisma.paymentRequest.count({
			where: {
				id: { in: paymentIds },
				NextAction: { requestedAction: { not: PaymentAction.WithdrawRequested } },
				CurrentTransaction: { txHash: { not: null } },
			},
		});
		if (done > 0 && firstCollectAt === null) firstCollectAt = performance.now();
		if (done > collectedCount) log(`  collected ${done}/${paymentIds.length}`);
		collectedCount = done;
		if (done === paymentIds.length) break;
		// Poll fast once the first escrow's cooldown has opened — otherwise the
		// polling interval, not the service, would set the measured collect rate.
		await new Promise((r) => setTimeout(r, firstCollectAt === null ? 15_000 : 250));
	}
	const tC1 = performance.now();
	const collected = await prisma.paymentRequest.findMany({
		where: {
			id: { in: paymentIds },
			NextAction: { requestedAction: { not: PaymentAction.WithdrawRequested } },
			CurrentTransaction: { txHash: { not: null } },
		},
	});
	const cooldownSec = firstCollectAt !== null ? (firstCollectAt - tC0) / 1000 : (tC1 - tC0) / 1000;
	const collectSec = firstCollectAt !== null ? Math.max((tC1 - firstCollectAt) / 1000, 1) : 0;
	const scriptsEnd = await scriptUtxoCount();
	log(`Phase C done: ${collected.length}/${paymentIds.length} collected — cooldown wait ${cooldownSec.toFixed(0)}s, active ${collectSec.toFixed(1)}s, script UTxOs now ${scriptsEnd}`);

	// ── Report ────────────────────────────────────────────────────────────────
	const activeSec = lockSec + submitSec + collectSec;
	const totalSec = activeSec + cooldownSec;
	const lifecycles = collected.length;
	const result = {
		startedAt: new Date().toISOString(),
		config: {
			escrows: N,
			lockLovelace: LOCK_LOVELACE.toString(),
			txShape: 'V2 vested_pay escrow: lock (into script) + submit-result (Plutus spend) + collect (Plutus spend)',
			drivenBy: 'masumi services: processL2PurchaseLocks / submitResultV2 / collectOutstandingPaymentsV2',
			node: NODE1_HTTP,
			network: 'preprod',
		},
		environment: {
			hardware: `${cpus()[0]?.model ?? 'unknown'} (${cpus().length} cores), ${platform()} ${arch()}`,
			cooldownTimeMs: 60000,
		},
		results: {
			locked: locked.length,
			submitted: submitted.length,
			collected: collected.length,
			lockSec: +lockSec.toFixed(1),
			submitSec: +submitSec.toFixed(1),
			collectSec: +collectSec.toFixed(1),
			cooldownWaitSec: +cooldownSec.toFixed(1),
			locksPerSec: +(locked.length / lockSec).toFixed(2),
			submitsPerSec: +(submitted.length / submitSec).toFixed(2),
			collectsPerSec: +(collected.length / collectSec).toFixed(2),
			escrowTxTotal: locked.length + submitted.length + collected.length,
			escrowTxPerSecActive: +((locked.length + submitted.length + collected.length) / activeSec).toFixed(2),
			lifecyclesPerSecActive: +(lifecycles / activeSec).toFixed(3),
			lifecyclesPerSecWall: +(lifecycles / totalSec).toFixed(3),
		},
	};
	const outDir = join(process.cwd(), 'hydra-l2-flow', 'evidence', 'bench-escrow', result.startedAt.replace(/[:.]/g, '-'));
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2));
	writeFileSync(
		join(outDir, 'SUMMARY.md'),
		`# Masumi escrow e2e bench — preprod — ${result.startedAt}\n\n` +
			`| metric | value |\n|---|---|\n` +
			`| escrow lifecycles completed | ${lifecycles}/${N} |\n` +
			`| locks/sec | ${result.results.locksPerSec} (${locked.length} in ${result.results.lockSec}s) |\n` +
			`| submit-results/sec (Plutus) | ${result.results.submitsPerSec} (${submitted.length} in ${result.results.submitSec}s) |\n` +
			`| collects/sec (Plutus) | ${result.results.collectsPerSec} (${collected.length} in ${result.results.collectSec}s) |\n` +
			`| escrow txs/sec (active) | ${result.results.escrowTxPerSecActive} |\n` +
			`| lifecycles/sec (active / incl. cooldown) | ${result.results.lifecyclesPerSecActive} / ${result.results.lifecyclesPerSecWall} |\n` +
			`| contract cooldown wait | ${result.results.cooldownWaitSec}s (configured parameter, not infra) |\n` +
			`| driven by | masumi production services (same code the crons run) |\n` +
			`| hardware | ${result.environment.hardware} |\n`,
	);
	log(`evidence written to ${outDir}`);
	log(
		`RESULT: lifecycles ${lifecycles}/${N} | ops/sec lock=${result.results.locksPerSec} submit=${result.results.submitsPerSec} collect=${result.results.collectsPerSec} | escrow-tx/s (active) ${result.results.escrowTxPerSecActive}`,
	);
	process.exit(collected.length === N ? 0 : 3);
}

main().catch((e) => {
	console.error('[escrow-bench] FATAL', e);
	process.exit(1);
});
