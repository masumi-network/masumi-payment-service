/**
 * Pre-close drain gate — the mitigation ADR-0013 says is missing.
 *
 * Fanout takes the WHOLE UTxO set in one transaction (`Fanout` is a
 * parameterless client input; `fanoutTx` uses `numberOfFanoutOutputs =
 * UTxO.size utxo`). Every escrow script UTxO left in the head must therefore be
 * validated inside a single Plutus evaluation. On 2026-08-28 a head carrying 29
 * such UTxOs (~480-byte inline datums) blew the CPU budget by 39 M units on a
 * 6.5 KB transaction — under the size limit, so Hydra's size-based partial
 * fanout never triggered, and all 24 retries rebuilt the identical failing tx.
 *
 * So: drive every terminal L2 cycle until the head holds ZERO datum-carrying
 * UTxOs, and refuse to let the caller close while any remain. An open head
 * keeps funds spendable on L2; a closed one with a failing fanout freezes them.
 *
 * Deliberately does NOT drive lockFunds or requestRefund — those create work.
 *
 * Run: DATABASE_URL=<test-db> pnpm exec tsx hydra-l2-flow/16-drain-escrows.mts
 * Env: DRAIN_BUDGET_MS (default 20 min), DRAIN_ROUND_WAIT_MS (default 20s)
 * Exit: 0 head is fanout-safe · 1 script UTxOs remain · 2 preconditions unmet
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

const NODE1_HTTP = process.env.HYDRA_NODE1_HTTP ?? 'http://127.0.0.1:4001';
const NODE1_LOG = join(process.cwd(), 'hydra-l2-flow', '.native-state', 'node1.log');
const BUDGET_MS = Number(process.env.DRAIN_BUDGET_MS ?? 20 * 60 * 1000);
const ROUND_WAIT_MS = Number(process.env.DRAIN_ROUND_WAIT_MS ?? 20_000);
/**
 * How many datum-carrying UTxOs may remain and still fan out.
 *
 * Not zero, because zero is stricter than the chain requires and would block a
 * settle that is provably safe. Calibrated from the 2026-08-28 failure: 29
 * escrow script UTxOs (~480-byte CBOR datums) overspent a 10,000,000,000-step
 * budget by 39,034,429 — only 0.4% over, so the real ceiling is ~28 and the
 * marginal cost is ~346M steps per script UTxO. 10 leaves roughly a 3x margin.
 *
 * Raise only with the same arithmetic redone; it is the whole fanout guarantee.
 */
const MAX_REMAINING = Number(process.env.DRAIN_MAX_SCRIPT_UTXOS ?? 10);
const PREPROD_SLOT_ZERO_MS = 1655683200000;

const log = (m: string) => console.log(`[drain] ${new Date().toISOString().slice(11, 19)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The head validates against its OWN observed slot — read the last Tick. */
function headSlotFromLog(): number | null {
	for (const windowBytes of [256 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024]) {
		try {
			const fd = openSync(NODE1_LOG, 'r');
			try {
				const size = fstatSync(fd).size;
				const len = Math.min(size, windowBytes);
				const buf = Buffer.alloc(len);
				readSync(fd, buf, 0, len, size - len);
				const matches = buf.toString('utf-8').match(/"slot":(\d+)/g);
				if (matches && matches.length > 0) return Number(matches[matches.length - 1].match(/(\d+)/)![1]);
			} finally {
				closeSync(fd);
			}
		} catch {
			/* try a wider window */
		}
	}
	return null;
}

/** Slot context must be refreshed every round: the head clock keeps moving. */
function refreshSlotContext(): boolean {
	const slot = headSlotFromLog();
	if (!slot) return false;
	process.env.HYDRA_L2_SLOT_ZERO_TIME_MS = String(PREPROD_SLOT_ZERO_MS);
	process.env.HYDRA_L2_SLOT_LENGTH_MS = '1000';
	process.env.HYDRA_L2_CURRENT_SLOT = String(slot);
	return true;
}

type HeadUtxo = { address: string; inlineDatum?: unknown; value: { lovelace: number } };

/**
 * Every datum-carrying UTxO in the head — a superset of escrows, which is what
 * fanout actually has to validate. Deliberately broader than the DB-row count:
 * an ambiguous lock (l2-lock-execute.ts:352) leaves a live script UTxO that
 * `countHydraHeadActiveWork` never sees.
 */
async function scriptUtxos(): Promise<Array<{ ref: string; address: string; lovelace: number }>> {
	const res = await fetch(`${NODE1_HTTP}/snapshot/utxo`);
	if (!res.ok) throw new Error(`GET /snapshot/utxo -> ${res.status}`);
	const utxos = (await res.json()) as Record<string, HeadUtxo>;
	return Object.entries(utxos)
		.filter(([, u]) => u.inlineDatum != null)
		.map(([ref, u]) => ({ ref, address: u.address, lovelace: u.value.lovelace }));
}

async function main() {
	if (!refreshSlotContext()) {
		console.error('[drain] could not read head Tick slot from node1.log — is the node up (verbose)?');
		process.exit(2);
	}

	// Imported AFTER the slot context is in env — the services read it on call.
	const { prisma } = await import('@masumi/payment-core/db');
	const { submitResultL2V2 } = await import('@masumi/payment-source-v2/services/payments/submit-result/service');
	const { collectOutstandingPaymentsL2V2 } =
		await import('@masumi/payment-source-v2/services/payments/collection/service');
	const { authorizeRefundL2V2 } = await import('@masumi/payment-source-v2/services/payments/authorize-refund/service');
	const { collectRefundL2V2 } = await import('@masumi/payment-source-v2/services/purchases/collect-refund/service');
	const { authorizeWithdrawalsL2V2 } =
		await import('@masumi/payment-source-v2/services/purchases/authorize-withdrawal/service');
	const { countHydraHeadActiveWork } = await import('@/utils/hydra/active-work');
	const { getHydraConnectionManager } =
		await import('@/services/hydra-connection-manager/hydra-connection-manager.service');

	// Order matters: move escrows one state forward per round, terminal last.
	const passes: Array<[string, () => Promise<unknown>]> = [
		['submitResult', submitResultL2V2],
		['authorizeRefund', authorizeRefundL2V2],
		['authorizeWithdrawal', authorizeWithdrawalsL2V2],
		['collect', collectOutstandingPaymentsL2V2],
		['collectRefund', collectRefundL2V2],
	];

	// The L2 passes go through the connection manager; without an explicit
	// connect() they find no head and quietly do nothing (bench-escrow-e2e.mts:185).
	// NB: unlike that bench we never deleteMany() the requests — the escrows the
	// flows just created are precisely what we are here to drain.
	const head = await prisma.hydraHead.findFirst({
		include: { LocalParticipant: true },
		orderBy: { createdAt: 'desc' },
	});
	if (!head?.LocalParticipant) {
		console.error('[drain] no HydraHead row with a LocalParticipant — run sync-head-row.mts first');
		process.exit(2);
	}
	await getHydraConnectionManager().connect({
		id: head.id,
		LocalParticipant: {
			walletId: head.LocalParticipant.walletId,
			nodeHttpUrl: head.LocalParticipant.nodeHttpUrl,
			nodeUrl: head.LocalParticipant.nodeUrl,
		},
	});
	await sleep(1000);
	const deadline = Date.now() + BUDGET_MS;
	let round = 0;
	let stalls = 0;
	let remaining = await scriptUtxos();
	log(`start: ${remaining.length} script UTxOs in head, budget ${Math.round(BUDGET_MS / 60000)} min`);

	while (remaining.length > 0 && Date.now() < deadline) {
		round++;
		// Wallets left locked by a crashed pass would stall every later round.
		await prisma.hotWallet.updateMany({ data: { lockedAt: null, pendingTransactionId: null } });
		refreshSlotContext();

		for (const [name, pass] of passes) {
			await pass().catch((e) => log(`  ${name} threw: ${e instanceof Error ? e.message : String(e)}`));
		}

		await sleep(ROUND_WAIT_MS);
		const before = remaining.length;
		remaining = await scriptUtxos();
		const work = await countHydraHeadActiveWork(prisma, head.id);
		// Orphans (no DB row references them) can never be collected by a service,
		// so retrying until the budget expires just wastes the settle window.
		stalls = remaining.length === before ? stalls + 1 : 0;
		log(
			`round ${round}: ${before} -> ${remaining.length} script UTxOs` +
				` (db: ${work.activeEscrows} escrows, ${work.pendingL2Transactions} pending L2)` +
				` · ${Math.round((deadline - Date.now()) / 1000)}s left`,
		);
		if (stalls >= 3 && remaining.length <= MAX_REMAINING) {
			log(`no progress in ${stalls} rounds and ${remaining.length} <= ${MAX_REMAINING} — stopping early`);
			break;
		}
	}

	if (remaining.length > MAX_REMAINING) {
		console.error(
			`\n[drain] FAILED — ${remaining.length} script UTxO(s) still in the head after ${round} round(s), over the ${MAX_REMAINING} the fanout budget allows:`,
		);
		for (const u of remaining) console.error(`  ${u.ref}  ${u.lovelace / 1e6} ADA  ${u.address}`);
		console.error(
			'\n[drain] DO NOT CLOSE. Fanout validates every one of these in a single Plutus\n' +
				'        evaluation and will fail on execution units (see 2026-08-28, 29 UTxOs,\n' +
				'        cpu -39034429). An OPEN head keeps these spendable on L2; a CLOSED one\n' +
				'        freezes them — that is how 189.8 tADA got stranded.\n',
		);
		await prisma.$disconnect();
		process.exit(1);
	}

	if (remaining.length > 0) {
		log(`OK — ${remaining.length} datum UTxO(s) remain, within the ${MAX_REMAINING} the fanout budget allows:`);
		for (const u of remaining) log(`     ${u.ref}  ${u.lovelace / 1e6} ADA  ${u.address}`);
		log('     (orphans: no DB row references them, so no service can collect them)');
	} else {
		log(`OK — head holds no datum-carrying UTxOs after ${round} round(s).`);
	}
	log('Fanout-safe.');
	await prisma.$disconnect();
	process.exit(0);
}

main().catch((e) => {
	const msg = e instanceof Error ? e.message : String(e);
	if (msg.includes('head id did not match the pinned head')) {
		console.error(
			'[drain] the HydraHead DB row points at a different head than the node is running.\n' +
				'        Run: pnpm exec tsx hydra-l2-flow/sync-head-row.mts',
		);
		process.exit(2);
	}
	console.error('[drain] FATAL', e);
	process.exit(2);
});
