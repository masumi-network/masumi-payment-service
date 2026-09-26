/**
 * One head's settlement cycle, driven through the payment service's own API:
 *   D deposits  : POST hydra/head/topup  -> wait for HydraTopupStatus.Absorbed
 *   W withdrawals: POST hydra/head/withdraw -> wait for HydraDecommitStatus.Finalized
 *   Close        : POST hydra/head/close -> wait for status FanoutPossible
 *   Fanout       : POST hydra/head/fanout -> wait for status Final + fanoutTxHash
 * Every settlement transaction appends one ledger row. Exit 0 only if all of
 * them reached their terminal state.
 *
 * Run: pnpm exec tsx hydra-l2-flow/18-settlement-cycle.mts --head-index 1 --deposits 4 --withdrawals 4
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, appendLedger, EVIDENCE_ROOT, log, poll, readLedger } from './m4-lib.mts';

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(name);
	return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const HEAD_INDEX = Number(arg('--head-index', '1'));
const DEPOSITS = Number(arg('--deposits', '4'));
const WITHDRAWALS = Number(arg('--withdrawals', '4'));
// An exact-amount deposit reuses any UTxO of that size the wallet already
// holds; this wallet holds a 10 ADA output with a datum (an old fanout
// output) that hydra-node refuses to commit. 10.5 ADA has no such collision,
// so the pre-split always carves a fresh plain UTxO instead.
const AMOUNT_LOVELACE = arg('--lovelace', '10500000');
// Withdraw less than was deposited: the withdraw endpoint holds back one UTxO
// as collateral unless `drain` is set, so withdrawing the full amount would
// fail on the last round. 4 x 10 ADA in, 4 x 8 ADA out, 8 ADA returns at fanout.
const WITHDRAW_LOVELACE = arg('--withdraw-lovelace', '8000000');
const LEDGER = arg('--ledger', join(EVIDENCE_ROOT, 'settlement', 'ledger.jsonl'));

const MINUTE = 60_000;
const DEPOSIT_DEADLINE_MS = 40 * MINUTE; // 600s deposit activation + chain-follower lag + pre-split confirm
const WITHDRAW_DEADLINE_MS = 20 * MINUTE;
const CLOSE_DEADLINE_MS = 20 * MINUTE; // contestation 220s + Blockfrost observation lag
const FANOUT_DEADLINE_MS = 20 * MINUTE;
// 2.4.1 never fills closeTxHash/fanoutTxHash on the head row (recordCloseTransaction's
// extractHeadOutputTxId looks for chainState at the top level of the node's /head
// reply, but 2.4.1 nests it under `contents`); fanoutTxHash is never written by the
// runtime at all. This is a product limitation, not something this script works
// around by changing product code — instead, once the head reaches the right
// status, the real hash is resolved straight from the chain via the existing
// head-token-policy anchor recorder.
const ANCHOR_RETRY_MS = 60_000;
const ANCHOR_RETRY_DEADLINE_MS = 10 * MINUTE;

type Head = { id: string; status: string; headIdentifier: string | null; closeTxHash: string | null; fanoutTxHash: string | null };
type Topup = { id: string; status: string; depositTxHash: string | null; committedLovelace: string; createdAt: string };
type Withdrawal = {
	id: string; status: string; l1TxId: string | null; requestedLovelace: string; settledLovelace: string | null;
	createdAt: string; failureReason: string | null;
};
type Balance = { connected: boolean; utxoCount: number; balance: Array<{ unit: string; quantity: string }> };

function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function logBalance(head: Head, when: string): Promise<void> {
	const b = await api<Balance>(`/hydra/head/balance?headId=${head.id}`);
	const lovelace = b.balance.find((entry) => entry.unit === '')?.quantity ?? '0';
	log('cycle', `in-head balance ${when}: ${lovelace} lovelace in ${b.utxoCount} UTxO(s), connected=${b.connected}`);
}

async function openHead(): Promise<Head> {
	// Not `&status=Open`: this same head is looked up again to resume Close/Fanout
	// after a prior run already moved it past Open (e.g. fix round 6, continuing
	// a head that's FanoutPossible).
	const { heads } = await api<{ heads: Head[] }>('/hydra/head?network=Preprod&limit=25');
	const active = heads.filter((h) => h.status === 'Open' || h.status === 'FanoutPossible');
	if (active.length !== 1) throw new Error(`expected exactly one Open/FanoutPossible head, found ${active.length}`);
	if (!active[0].headIdentifier) throw new Error('active head has no headIdentifier yet');
	return active[0];
}

async function headById(id: string): Promise<Head> {
	const { heads } = await api<{ heads: Head[] }>(`/hydra/head?id=${id}`);
	if (heads.length !== 1) throw new Error(`head ${id} not found`);
	return heads[0];
}

/** True if this head already has a ledger row of this kind, e.g. from a prior
 * run that reached Close/Fanout and exited before this run started (a rerun
 * against the same still-FanoutPossible/Final head must never duplicate it). */
function alreadyRecorded(headId: string, kind: 'close' | 'fanout'): boolean {
	return readLedger(LEDGER).some((row) => row.headId === headId && row.kind === kind);
}

type Anchors = { closeTx: string | null; fanoutTx: string | null };

/**
 * Resolve a head's close AND fanout tx hashes straight from the chain, since
 * fanoutTxHash is never written by the runtime at all. Runs the head-token-
 * policy anchor recorder (17-record-l1-anchors.mts) and retries on Blockfrost
 * indexing lag. The recorder names `closeTx` only as the parent of `fanoutTx`
 * (it traces backward from the burn), so it can never answer before the
 * fanout itself exists — callers must only call this once the head is
 * already `Final`, never right after `FanoutPossible`.
 */
async function resolveAnchors(headIdentifier: string): Promise<Anchors> {
	const outFile = join(tmpdir(), `m4-anchors-${headIdentifier}.json`);
	const started = Date.now();
	for (;;) {
		try {
			execFileSync(
				'pnpm',
				['exec', 'tsx', 'hydra-l2-flow/17-record-l1-anchors.mts', '--head-id', headIdentifier, '--out', outFile],
				{ cwd: process.cwd(), env: { ...process.env, SINCE_HOURS: '12' }, stdio: 'pipe' },
			);
			const anchors = JSON.parse(readFileSync(outFile, 'utf8')) as Anchors;
			if (anchors.fanoutTx) return anchors;
		} catch (error) {
			log('cycle', `anchor recorder read failed: ${errMsg(error)}`);
		}
		if (Date.now() - started > ANCHOR_RETRY_DEADLINE_MS) {
			throw new Error(`fanoutTx never appeared from the anchor recorder within ${Math.round(ANCHOR_RETRY_DEADLINE_MS / 1000)}s`);
		}
		await new Promise((resolve) => setTimeout(resolve, ANCHOR_RETRY_MS));
	}
}

async function deposit(head: Head, n: number): Promise<void> {
	const startedAt = new Date().toISOString();
	log('cycle', `deposit ${n}/${DEPOSITS}: ${AMOUNT_LOVELACE} lovelace`);
	await api('/hydra/head/topup', { method: 'POST', body: { headId: head.id, exactAmount: AMOUNT_LOVELACE, assetFilter: 'ada-only' } });
	const absorbed = await poll(
		`deposit ${n} absorbed`,
		async () => {
			let topups: Topup[];
			try {
				({ topups } = await api<{ topups: Topup[] }>(`/hydra/head/topup?headId=${head.id}&limit=5`));
			} catch (error) {
				log('cycle', `deposit ${n} topup read failed: ${errMsg(error)}`);
				return null;
			}
			const mine = topups.filter((t) => t.createdAt >= startedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
			if (!mine) return null;
			if (mine.status === 'Failed' || mine.status === 'Recovered') throw new Error(`deposit ${n} ended ${mine.status}`);
			return mine.status === 'Absorbed' && mine.depositTxHash ? mine : null;
		},
		{ everyMs: 15_000, deadlineMs: DEPOSIT_DEADLINE_MS },
	);
	appendLedger(LEDGER, {
		headIndex: HEAD_INDEX, headId: head.id, headIdentifier: head.headIdentifier!, kind: 'deposit',
		txHash: absorbed.depositTxHash!, lovelace: absorbed.committedLovelace, startedAt, doneAt: new Date().toISOString(),
	});
	log('cycle', `deposit ${n} absorbed: ${absorbed.depositTxHash}`);
}

const WITHDRAW_FOLD_RETRY_MS = 60_000;
const WITHDRAW_FOLD_RETRIES = 15;
// Every hydra-node follows L1 through its own Blockfrost poll, so a peer can
// observe a DecrementTx up to ~20s after the node the service talks to; a
// withdrawal requested inside that gap is rejected by the lagging peer
// (DecommitAlreadyInFlight) and wedges the requesting node's decommit with no
// cancel — seen 2026-09-18 on head 3 withdrawal 21. 45s covers two polls.
const WITHDRAW_SETTLE_PAUSE_MS = 45_000;

/** Thrown when a withdrawal is refused only because the deposit hasn't folded in yet. */
class FoldingInError extends Error {}

async function withdraw(head: Head, n: number): Promise<void> {
	const startedAt = new Date().toISOString();
	// Unless `drain` is set, the service holds back the smallest in-head wallet
	// UTxO of at least 5 ADA as collateral; with only one UTxO in the head that
	// leaves nothing eligible, so the last withdrawal drains instead of naming
	// an amount, decommitting every remaining eligible UTxO (collateral included).
	const isLast = n === WITHDRAWALS;
	const body = isLast ? { headId: head.id, drain: true } : { headId: head.id, lovelace: WITHDRAW_LOVELACE };
	log('cycle', `withdrawal ${n}/${WITHDRAWALS}: ${isLast ? 'drain' : `${WITHDRAW_LOVELACE} lovelace`}`);
	let finalized: Withdrawal | undefined;
	for (let attempt = 1; attempt <= WITHDRAW_FOLD_RETRIES; attempt += 1) {
		const attemptStartedAt = new Date().toISOString();
		await api('/hydra/head/withdraw', { method: 'POST', body });
		try {
			// The node clears a deposit's refs from pendingIncrementUtxoRefs only once
			// its OWN chain follower observes the increment (CommitFinalized); the
			// service marks the topup Absorbed from its own, earlier Blockfrost read,
			// so a withdrawal right after Absorbed is correctly refused until the node
			// catches up. The mirror case exists on the way out too: the node keeps a
			// decommit in the confirmed snapshot's utxoToDecommit until it observes
			// that decommit's DecrementTx, so the very next withdrawal is refused
			// ("still being settled on L1"), or — if it slips past that guard — its
			// in-head split is accepted but can never snapshot-confirm within the
			// service's wait ("nothing has left the head"). When a split lands in a
			// stranded snapshot round, the retry rebuilds the same split and the node
			// rejects it as already spent; once the round recovers the exact-UTxO
			// reuse decommits the already-split output. Retry all five specific
			// refusals instead of treating them as real failures.
			finalized = await poll(
				`withdrawal ${n} finalized (attempt ${attempt})`,
				async () => {
					let withdrawals: Withdrawal[];
					try {
						({ withdrawals } = await api<{ withdrawals: Withdrawal[] }>(`/hydra/head/withdraw?headId=${head.id}&limit=5`));
					} catch (error) {
						log('cycle', `withdrawal ${n} read failed: ${errMsg(error)}`);
						return null;
					}
					const mine = withdrawals.filter((w) => w.createdAt >= attemptStartedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
					if (!mine) return null;
					if (mine.status === 'Failed') {
						const retryable =
							mine.failureReason?.includes('still being folded') ||
							mine.failureReason?.includes('still being settled on L1') ||
							mine.failureReason?.includes('nothing has left the head') ||
							mine.failureReason?.includes('All inputs are spent') ||
							mine.failureReason?.includes('Transaction is invalid');
						if (retryable) throw new FoldingInError(mine.failureReason!);
						throw new Error(`withdrawal ${n} failed: ${mine.failureReason ?? 'unknown reason'}`);
					}
					if (mine.status !== 'Finalized' || !mine.l1TxId) return null;
					const { l1TxId } = mine;
					// Fail fast on Defect H (duplicate L1 attribution) instead of recording a ledger row that collides with an earlier withdrawal's.
					if (readLedger(LEDGER).some((row) => row.txHash === l1TxId)) {
						throw new Error(`withdrawal ${n}: the service reported payout ${l1TxId} which is already recorded in the ledger`);
					}
					return mine;
				},
				{ everyMs: 15_000, deadlineMs: WITHDRAW_DEADLINE_MS },
			);
			break;
		} catch (error) {
			if (!(error instanceof FoldingInError) || attempt === WITHDRAW_FOLD_RETRIES) throw error;
			log('cycle', `withdrawal ${n} attempt ${attempt} refused (${error.message}); retrying in 60s`);
			await new Promise((resolve) => setTimeout(resolve, WITHDRAW_FOLD_RETRY_MS));
		}
	}
	if (!finalized) throw new Error(`withdrawal ${n} never finalized after ${WITHDRAW_FOLD_RETRIES} attempts`);
	appendLedger(LEDGER, {
		headIndex: HEAD_INDEX, headId: head.id, headIdentifier: head.headIdentifier!, kind: 'withdrawal',
		txHash: finalized.l1TxId!, lovelace: finalized.requestedLovelace, settledLovelace: finalized.settledLovelace,
		startedAt, doneAt: new Date().toISOString(),
	});
	log('cycle', `withdrawal ${n} finalized: ${finalized.l1TxId} (settled ${finalized.settledLovelace})`);
	if (!isLast) {
		log('cycle', 'settle pause 45s (let every peer observe the decrement)');
		await new Promise((resolve) => setTimeout(resolve, WITHDRAW_SETTLE_PAUSE_MS));
	}
}

type CloseResult = { closeTxHash: string | null; startedAt: string; doneAt: string };

async function close(head: Head): Promise<CloseResult> {
	const startedAt = new Date().toISOString();
	log('cycle', 'close');
	// Idempotent: an earlier attempt may have already landed the Close (e.g. a
	// prior run of this script failed after FanoutPossible but before recording
	// it) — Close itself is not safe to re-POST once accepted, so check first.
	// Wrapped in the same log-and-retry shape as every poll callback below: a
	// transient read blip here must not kill an otherwise-healthy 40-minute cycle.
	let h = await poll(
		'close: read current head status',
		async () => {
			try {
				return await headById(head.id);
			} catch (error) {
				log('cycle', `close initial status read failed: ${errMsg(error)}`);
				return null;
			}
		},
		{ everyMs: 20_000, deadlineMs: 5 * MINUTE },
	);
	if (h.status === 'FanoutPossible') {
		log('cycle', 'close: head is already FanoutPossible, skipping the POST');
	} else {
		await api('/hydra/head/close', { method: 'POST', body: { headId: head.id } });
		h = await poll(
			'close -> FanoutPossible',
			async () => {
				let polled: Head;
				try {
					polled = await headById(head.id);
				} catch (error) {
					log('cycle', `close status read failed: ${errMsg(error)}`);
					return null;
				}
				return polled.status === 'FanoutPossible' ? polled : null;
			},
			{ everyMs: 20_000, deadlineMs: CLOSE_DEADLINE_MS },
		);
	}
	const doneAt = new Date().toISOString();
	// The service's own closeTxHash may still be null even once FanoutPossible
	// (a product limitation on some builds); the anchor recorder can't fill the
	// gap yet either, because it names Close only as Fanout's parent and Fanout
	// hasn't happened. Record now if we can; otherwise let fanout() write this
	// row afterwards, once the recorder can actually answer.
	if (h.closeTxHash) {
		if (alreadyRecorded(head.id, 'close')) {
			log('cycle', `close: row for ${h.closeTxHash} already recorded by an earlier run, not appending again`);
		} else {
			appendLedger(LEDGER, {
				headIndex: HEAD_INDEX, headId: head.id, headIdentifier: head.headIdentifier!, kind: 'close',
				txHash: h.closeTxHash, lovelace: null, startedAt, doneAt,
			});
			log('cycle', `closed: ${h.closeTxHash}`);
		}
	} else {
		log('cycle', 'close observed FanoutPossible but closeTxHash is still null on the head row; fanout will resolve and record it from the chain');
	}
	return { closeTxHash: h.closeTxHash, startedAt, doneAt };
}

async function fanout(head: Head, closeResult: CloseResult): Promise<void> {
	const startedAt = new Date().toISOString();
	log('cycle', 'fanout');
	await api('/hydra/head/fanout', { method: 'POST', body: { headId: head.id } });
	await poll(
		'fanout -> Final',
		async () => {
			let h: Head;
			try {
				h = await headById(head.id);
			} catch (error) {
				log('cycle', `fanout status read failed: ${errMsg(error)}`);
				return null;
			}
			return h.status === 'Final' ? h : null;
		},
		{ everyMs: 20_000, deadlineMs: FANOUT_DEADLINE_MS },
	);
	log('cycle', 'fanout observed Final; resolving hashes from the chain');
	const anchors = await resolveAnchors(head.headIdentifier!);
	if (closeResult.closeTxHash && anchors.closeTx && closeResult.closeTxHash !== anchors.closeTx) {
		throw new Error(`closeTxHash mismatch: service said ${closeResult.closeTxHash}, chain says ${anchors.closeTx}`);
	}
	if (!closeResult.closeTxHash) {
		if (!anchors.closeTx) throw new Error('close tx hash unknown from both the service and the anchor recorder');
		if (alreadyRecorded(head.id, 'close')) {
			log('cycle', `close: row for ${anchors.closeTx} already recorded by an earlier run, not appending again`);
		} else {
			appendLedger(LEDGER, {
				headIndex: HEAD_INDEX, headId: head.id, headIdentifier: head.headIdentifier!, kind: 'close',
				txHash: anchors.closeTx, lovelace: null, startedAt: closeResult.startedAt, doneAt: closeResult.doneAt,
			});
			log('cycle', `closed (recorded from chain): ${anchors.closeTx}`);
		}
	}
	if (!anchors.fanoutTx) throw new Error('fanout tx hash unknown from the anchor recorder');
	if (alreadyRecorded(head.id, 'fanout')) {
		log('cycle', `fanout: row for ${anchors.fanoutTx} already recorded by an earlier run, not appending again`);
	} else {
		appendLedger(LEDGER, {
			headIndex: HEAD_INDEX, headId: head.id, headIdentifier: head.headIdentifier!, kind: 'fanout',
			txHash: anchors.fanoutTx, lovelace: null, startedAt, doneAt: new Date().toISOString(),
		});
		log('cycle', `final: ${anchors.fanoutTx}`);
	}
}

async function main(): Promise<void> {
	const head = await openHead();
	log('cycle', `head ${HEAD_INDEX}: ${head.id} (${head.headIdentifier})`);
	await logBalance(head, 'before deposits');
	for (let n = 1; n <= DEPOSITS; n += 1) await deposit(head, n);
	await logBalance(head, 'after deposits');
	for (let n = 1; n <= WITHDRAWALS; n += 1) await withdraw(head, n);
	await logBalance(head, 'after withdrawals');
	const closeResult = await close(head);
	await fanout(head, closeResult);
	log('cycle', `head ${HEAD_INDEX} complete: ${DEPOSITS + WITHDRAWALS + 2} settlement transactions`);
	process.exit(0);
}

main().catch((error) => {
	console.error(`[cycle] FAILED: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
