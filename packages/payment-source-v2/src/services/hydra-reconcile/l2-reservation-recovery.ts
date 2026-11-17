import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus, Network, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import { fetchHydraSnapshotRound, type HydraSnapshotRound } from '@/lib/hydra/hydra/node-control-queries';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { hydraValidityUpperBoundTimeMs } from '@/services/hydra-connection-manager/hydra-transaction-evidence';
import { convertNetwork } from '@/utils/converter/network-convert';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import { isL2ReservationSpentByNudge, type L2ReleaseValueFloor } from './l2-release-nudge-proof';
import { releaseRejectedL2Reservation } from './l2-reservation-release';
import {
	L2_RELEASE_NUDGE_INTERVAL_MS,
	nudgeIdleHeadForRelease,
	type L2ReleaseNudgeCandidate,
} from './l2-reservation-nudge';

export const L2_RESERVATION_EXPIRY_GRACE_MS = 60_000;
export const EXPIRED_L2_RESERVATION_WARNING_INTERVAL_MS = 60 * 60_000;
const L2_RECOVERY_CLOCK_MAX_AGE_MS = 60_000;
const L2_RECOVERY_CLOCK_FUTURE_SKEW_MS = 5_000;
const MAX_EXPIRED_L2_WARNING_KEYS = 10_000;
const expiredL2WarningTimes = new Map<string, number>();
const MAX_EXPIRED_L2_WARNING_SAMPLES = 10;
/**
 * Slack past expiry before a reservation may be released. Hydra's ledger time
 * advances only on chain ticks, so the head can still accept a body briefly
 * after its wall-clock expiry.
 */
export const L2_RESERVATION_RELEASE_GRACE_MS = 5 * 60_000;
/**
 * Slack past expiry for the slower releases: automatic release of an action,
 * which has no nudge, and an admin release of a row automatic recovery can still
 * release. The release grace plus five nudge intervals.
 */
export const L2_OPERATOR_RELEASE_GRACE_MS = L2_RESERVATION_RELEASE_GRACE_MS + 5 * L2_RELEASE_NUDGE_INTERVAL_MS;
/** What the node itself reports now, read live and never from replay. */
export type HydraLiveSnapshot = {
	round: HydraSnapshotRound;
	/** Output refs (`txHash#index`, lowercase) in the node's confirmed snapshot. */
	liveRefs: ReadonlySet<string>;
};

const lastActionSnapshotReadAtByHead = new Map<string, number>();

/**
 * The live snapshot for this scan's action releases, or null to hold them. Null
 * unless the head row is Open and not closing: a contest can still carry a snapshot our node
 * signed but never saw complete. Read at most once per nudge interval per head:
 * an action that never releases (all its inputs spent) must not cost a full
 * UTxO fetch on every reconcile tick.
 */
async function readActionLiveSnapshot(
	hydraHeadId: string,
	nowMs: number,
	database: typeof prisma,
	read: () => Promise<HydraLiveSnapshot>,
): Promise<HydraLiveSnapshot | null> {
	for (const [headId, readAtMs] of lastActionSnapshotReadAtByHead) {
		if (readAtMs > nowMs || nowMs - readAtMs >= L2_RELEASE_NUDGE_INTERVAL_MS)
			lastActionSnapshotReadAtByHead.delete(headId);
	}
	if (lastActionSnapshotReadAtByHead.has(hydraHeadId)) return null;
	try {
		const isHeadOpen = async () => {
			const head = await database.hydraHead.findUnique({
				where: { id: hydraHeadId },
				select: { status: true, isClosing: true },
			});
			return head?.status === HydraHeadStatus.Open && !head.isClosing;
		};
		if (!(await isHeadOpen())) return null;
		const snapshot = await read();
		// A close posted while the snapshot was read voids it.
		if (!(await isHeadOpen())) return null;
		// Only a read that could release starts the window: a node error or a
		// round in flight retries on the next scan instead of holding every action
		// for a full interval.
		if (!snapshot.round.inFlight) lastActionSnapshotReadAtByHead.set(hydraHeadId, nowMs);
		return snapshot;
	} catch (error) {
		if (shouldWarnExpiredL2Reservation(`${hydraHeadId}:live-snapshot`, nowMs)) {
			logger.warn('[HydraReconcile] could not read the live snapshot for expired L2 actions; they stay held', {
				hydraHeadId,
				error: error instanceof Error ? error.message : error,
			});
		}
		return null;
	}
}

/**
 * Read the node's snapshot round, then its confirmed UTxO set. The round is read
 * first, so a round that confirms between the two reads shows up in the UTxO set
 * instead of slipping past both. Replay is never the source here: on 2026-10-22
 * the history stream went silent while the head clock stayed fresh.
 */
export async function readHydraLiveSnapshot(node: HydraNode, withUtxos = true): Promise<HydraLiveSnapshot> {
	const round = await fetchHydraSnapshotRound(node);
	// A round in flight already voids the answer, so the full UTxO set is skipped.
	const utxos = withUtxos && !round.inFlight ? await node.snapshotUTxO() : [];
	// Same shape as `requireHydraInputRefs`, which recorded the refs.
	return {
		round,
		liveRefs: new Set(utxos.map((utxo) => `${utxo.input.txHash}#${utxo.input.outputIndex}`.toLowerCase())),
	};
}

/**
 * A body input still in the live confirmed snapshot, or undefined. An output is
 * spent once and a body applies atomically, so one such input proves the body
 * is not in that snapshot. Meaningless while a round is in flight.
 */
export function findLiveBodyInput(snapshot: HydraLiveSnapshot, inputRefs: readonly string[]): string | undefined {
	return inputRefs.find((reference) => snapshot.liveRefs.has(reference));
}

export type L2ReservationRecoveryGate = {
	hasVerifiedPinnedSessions: boolean;
	historyReady: boolean;
	queuedTransactions: number;
	headClock: { chainTimeMs: number; receivedAtMs: number } | undefined;
	nowMs: number;
	validityUpperBoundTimeMs: bigint | null;
	graceMs?: number;
};

/** Pure, fail-closed gate for reporting a reservation as expired. */
export function canReportExpiredL2Reservation(gate: L2ReservationRecoveryGate): boolean {
	const graceMs = gate.graceMs ?? L2_RESERVATION_EXPIRY_GRACE_MS;
	const clock = gate.headClock;
	if (
		!gate.hasVerifiedPinnedSessions ||
		!gate.historyReady ||
		gate.queuedTransactions !== 0 ||
		clock == null ||
		gate.validityUpperBoundTimeMs == null ||
		!Number.isSafeInteger(gate.nowMs) ||
		!Number.isSafeInteger(graceMs) ||
		graceMs < 0 ||
		!Number.isSafeInteger(clock.chainTimeMs) ||
		clock.chainTimeMs < 0 ||
		!Number.isSafeInteger(clock.receivedAtMs) ||
		clock.receivedAtMs < 0
	) {
		return false;
	}
	if (clock.receivedAtMs > gate.nowMs + L2_RECOVERY_CLOCK_FUTURE_SKEW_MS) return false;
	if (clock.chainTimeMs > gate.nowMs + L2_RECOVERY_CLOCK_FUTURE_SKEW_MS) return false;
	if (gate.nowMs - clock.receivedAtMs > L2_RECOVERY_CLOCK_MAX_AGE_MS) return false;
	return BigInt(clock.chainTimeMs) > gate.validityUpperBoundTimeMs + BigInt(graceMs);
}

/**
 * Release expired L2 reservations that are provably dead and report the rest.
 * This MUTATES state for the released ones.
 *
 * Hydra history replay proves which transactions reached a signed snapshot,
 * but cannot prove that a locally accepted transaction is absent from the live
 * ledger while it remains unsnapshotted. Releasing on negative replay evidence,
 * or on a node's TxInvalid, could authorize a conflicting retry. A reservation
 * lock is released only once its own release nudge, which spends the body's
 * wallet inputs, shows up in a verified snapshot (`./l2-release-nudge-proof`).
 * A non-locking action is released on the node's live state instead
 * (`releaseActionIfBodyUnapplied`). Everything else stays fail-closed and
 * reported.
 */
export async function reportExpiredL2Reservations(params: {
	hydraHeadId: string;
	network: Network;
	node: HydraNode;
	nowMs?: number;
	database?: typeof prisma;
	/** Makes an idle head confirm the newer snapshot release waits for. */
	nudge?: (candidate: L2ReleaseNudgeCandidate) => Promise<unknown>;
	/** The node's live snapshot; an action is released only against it. */
	readLiveSnapshot?: () => Promise<HydraLiveSnapshot>;
	/** Whether `node` is still the session the connection manager holds. */
	isCurrentNode?: () => boolean;
}): Promise<number> {
	const { hydraHeadId, network, node, nowMs = Date.now(), database = prisma } = params;
	// The head clock as it stood before the live snapshot is read. An action is
	// released only if it was already past its grace on this clock, so the one
	// snapshot read below, shared by every action of the scan, came after expiry.
	const scanHeadClock = node.headClock;
	const readLiveSnapshot = params.readLiveSnapshot ?? (() => readHydraLiveSnapshot(node));
	const isCurrentNode = params.isCurrentNode ?? (() => getHydraConnectionManager().getNode(hydraHeadId) === node);
	let liveSnapshot: Promise<HydraLiveSnapshot | null> | undefined;
	const readLiveSnapshotOnce = () =>
		(liveSnapshot ??= readActionLiveSnapshot(hydraHeadId, nowMs, database, readLiveSnapshot));
	const nudge =
		params.nudge ??
		((candidate: L2ReleaseNudgeCandidate) =>
			nudgeIdleHeadForRelease({ hydraHeadId, candidate, node, nowMs, database }));
	const queue = node.getConfirmedTransactionsForReconciliation();
	if (!node.hasVerifiedPinnedSessions || !node.confirmedTransactionHistoryReady || queue.length !== 0) return 0;

	const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(network));
	if (!slotConfig) return 0;
	pruneExpiredL2WarningThrottle(nowMs);
	const candidates = await database.transaction.findMany({
		where: {
			hydraHeadId,
			layer: TransactionLayer.L2,
			status: TransactionStatus.Pending,
			intendedTxHash: { not: null },
			invalidHereafterSlot: { not: null },
		},
		select: {
			id: true,
			intendedTxHash: true,
			invalidHereafterSlot: true,
			l2ReservationInputRefs: true,
			l2ReleaseNudgeTx: true,
			l2ReservationPreviousLayer: true,
			l2ReservationPreviousSmartContractWalletId: true,
			l2ReservationPreviousBuyerReturnAddress: true,
			l2ReservationPreviousCollateralReturn: true,
			l2ReservationPreviousTransactionId: true,
			...l2ReleaseValueFloorSelect,
		},
	});

	let reported = 0;
	const transactionIdSamples: string[] = [];
	for (const candidate of candidates) {
		if (candidate.intendedTxHash == null || candidate.invalidHereafterSlot == null) continue;
		// Confirmed evidence will be handled by the normal ordered replay path.
		if (node.getConfirmedTransaction(candidate.intendedTxHash)) continue;
		const validityUpperBoundTimeMs = hydraValidityUpperBoundTimeMs(
			{ validityUpperSlot: candidate.invalidHereafterSlot },
			slotConfig,
		);
		if (
			!canReportExpiredL2Reservation({
				hasVerifiedPinnedSessions: node.hasVerifiedPinnedSessions,
				historyReady: node.confirmedTransactionHistoryReady,
				queuedTransactions: node.getConfirmedTransactionsForReconciliation().length,
				headClock: node.headClock,
				nowMs,
				validityUpperBoundTimeMs,
			})
		) {
			continue;
		}

		// A node can relay a lock before expiry, withhold its signed snapshot,
		// and report TxInvalid for the same body. Expiry excludes future acceptance,
		// not past acceptance, so rejection alone never releases. Only the
		// nudge proof does. It reads the node's own verified snapshot: snapshot
		// confirmations never advance the persisted tip.
		const verifiedSnapshotNumber = node.verifiedSnapshotNumber;
		const isAction = candidate.l2ReservationPreviousTransactionId !== null;
		if (
			verifiedSnapshotNumber !== undefined &&
			canReportExpiredL2Reservation({
				hasVerifiedPinnedSessions: node.hasVerifiedPinnedSessions,
				historyReady: node.confirmedTransactionHistoryReady,
				queuedTransactions: node.getConfirmedTransactionsForReconciliation().length,
				headClock: isAction ? scanHeadClock : node.headClock,
				nowMs,
				validityUpperBoundTimeMs,
				graceMs: isAction ? L2_OPERATOR_RELEASE_GRACE_MS : L2_RESERVATION_RELEASE_GRACE_MS,
			}) &&
			(isAction
				? await releaseActionIfBodyUnapplied(
						candidate,
						node,
						hydraHeadId,
						database,
						readLiveSnapshotOnce,
						isCurrentNode,
					)
				: await releaseIfProvenDead(candidate, verifiedSnapshotNumber, node, hydraHeadId, database, nudge))
		) {
			continue;
		}

		reported += 1;
		if (transactionIdSamples.length < MAX_EXPIRED_L2_WARNING_SAMPLES) transactionIdSamples.push(candidate.id);
	}
	if (reported > 0 && shouldWarnExpiredL2Reservation(hydraHeadId, nowMs)) {
		logger.warn('[HydraReconcile] expired L2 reservations require explicit reconciliation', {
			hydraHeadId,
			expiredReservationCount: reported,
			transactionIdSamples,
		});
	}
	return reported;
}

function pruneExpiredL2WarningThrottle(nowMs: number): void {
	for (const [key, warnedAtMs] of expiredL2WarningTimes) {
		if (warnedAtMs > nowMs || nowMs - warnedAtMs >= EXPIRED_L2_RESERVATION_WARNING_INTERVAL_MS) {
			expiredL2WarningTimes.delete(key);
		}
	}
}

export const l2ReleaseValueFloorSelect = {
	PaymentRequestCurrent: { select: { id: true } },
	PurchaseRequestCurrent: { select: { PaidFunds: { select: { unit: true, amount: true } } } },
} as const;

/**
 * The funds the body locks, from our own records, or null when there is no
 * floor we can trust. Only an initial lock has one: its body moves the
 * purchases' paid funds into escrow, and a false release would make the buyer
 * lock them again. Any other row stays held for an operator.
 */
export function l2ReleaseValueFloor(candidate: {
	l2ReservationPreviousTransactionId: string | null;
	PaymentRequestCurrent: readonly unknown[];
	PurchaseRequestCurrent: ReadonlyArray<{ PaidFunds: ReadonlyArray<{ unit: string; amount: bigint }> }>;
}): L2ReleaseValueFloor | null {
	if (
		candidate.l2ReservationPreviousTransactionId !== null ||
		candidate.PaymentRequestCurrent.length > 0 ||
		candidate.PurchaseRequestCurrent.length === 0
	) {
		return null;
	}
	const floor = candidate.PurchaseRequestCurrent.flatMap((purchase) => purchase.PaidFunds);
	return floor.some((fund) => fund.amount > 0n) ? floor : null;
}

async function releaseIfProvenDead(
	candidate: Parameters<typeof releaseRejectedL2Reservation>[0] &
		Parameters<typeof l2ReleaseValueFloor>[0] & {
			intendedTxHash: string | null;
			l2ReservationInputRefs: string[];
			l2ReleaseNudgeTx: string | null;
		},
	snapshotNumber: bigint,
	node: HydraNode,
	hydraHeadId: string,
	database: typeof prisma,
	nudge: (candidate: L2ReleaseNudgeCandidate) => Promise<unknown>,
): Promise<boolean> {
	// Reservations made before inputs were recorded, and any without a value
	// floor, cannot be proven dead.
	const valueFloor = l2ReleaseValueFloor(candidate);
	if (candidate.l2ReservationInputRefs.length === 0 || valueFloor === null) return false;
	const spentByNudge = isL2ReservationSpentByNudge({
		nudgeTx: candidate.l2ReleaseNudgeTx,
		inputRefs: candidate.l2ReservationInputRefs,
		valueFloor,
		readOutput: (reference) => node.getVerifiedCurrentOutput(reference, snapshotNumber),
	});
	if (!spentByNudge) {
		await nudge({
			id: candidate.id,
			l2ReservationInputRefs: candidate.l2ReservationInputRefs,
			l2ReleaseNudgeTx: candidate.l2ReleaseNudgeTx,
			valueFloor,
		});
		return false;
	}
	const released = await releaseRejectedL2Reservation(candidate, database, 'spent-by-release-nudge');
	if (released) {
		logger.warn('[HydraReconcile] released expired L2 reservation: its release nudge spent the inputs', {
			hydraHeadId,
			transactionId: candidate.id,
			intendedTxHash: candidate.intendedTxHash,
			snapshotNumber: snapshotNumber.toString(),
		});
	}
	return released;
}

/**
 * Release an expired non-locking action (request, collect or authorize a
 * refund, submit a result, collect, ...) whose body cannot apply and has not.
 * An action has no value floor, and its escrow input is a script UTxO the wallet
 * cannot nudge-spend, so it is judged on the node's live state instead.
 * Fail-closed: every unknown retains. It needs, all at once:
 *
 * - the head is Open and its row is not closing: after a close, a contest can
 *   still carry a snapshot our node signed but never saw complete;
 * - the body was past its validity bound plus `L2_OPERATOR_RELEASE_GRACE_MS`
 *   (the wait an admin release of the same row has) on a fresh head clock
 *   read before the live snapshot (the caller's gate), so no snapshot request
 *   made after that read can still include it;
 * - the node session is still the one the manager holds, so a reconnect has
 *   not replayed a confirmation this check missed;
 * - the node reports no snapshot round in flight, so none signed before expiry
 *   can still confirm it;
 * - the body is in no confirmed history;
 * - at least ONE input the body spends is still in the node's live confirmed
 *   UTxO set. An output is spent once and a body applies atomically, so that
 *   input proves the body is not in the confirmed snapshot. A body that cannot
 *   land because another tx spent its escrow keeps its wallet inputs unspent and
 *   so still releases.
 *
 * This trusts the local node's live state, not a signed nudge output, so the row
 * gets its own stamp (`l2ReleasedByUnspentInputsAt`). These are the same checks
 * an admin release makes (`bodyMayHaveAppliedReason`), so a later confirmation
 * halts replay and the admin re-apply can undo it, as for an operator release.
 * An initial lock never takes this path: its double-lock risk needs the nudge
 * proof.
 */
async function releaseActionIfBodyUnapplied(
	candidate: Parameters<typeof releaseRejectedL2Reservation>[0] & {
		intendedTxHash: string | null;
		l2ReservationInputRefs: string[];
	},
	node: HydraNode,
	hydraHeadId: string,
	database: typeof prisma,
	readLiveSnapshot: () => Promise<HydraLiveSnapshot | null>,
	isCurrentNode: () => boolean,
): Promise<boolean> {
	const { intendedTxHash, l2ReservationInputRefs: inputRefs } = candidate;
	if (
		intendedTxHash === null ||
		inputRefs.length === 0 ||
		node.status !== HydraHeadStatus.Open ||
		node.getConfirmedTransaction(intendedTxHash)
	) {
		return false;
	}
	const snapshot = await readLiveSnapshot();
	if (snapshot === null || node.status !== HydraHeadStatus.Open || !isCurrentNode()) return false;
	const unspentInput = findLiveBodyInput(snapshot, inputRefs);
	if (snapshot.round.inFlight || node.getConfirmedTransaction(intendedTxHash) || unspentInput === undefined) {
		return false;
	}
	const released = await releaseRejectedL2Reservation(candidate, database, 'unspent-inputs');
	if (released) {
		logger.warn('[HydraReconcile] released expired L2 action reservation: its body cannot apply and did not', {
			hydraHeadId,
			transactionId: candidate.id,
			intendedTxHash,
			unspentInput,
			snapshotRoundTag: snapshot.round.tag,
			inputCount: inputRefs.length,
		});
	}
	return released;
}

function shouldWarnExpiredL2Reservation(key: string, nowMs: number): boolean {
	if (expiredL2WarningTimes.has(key)) return false;
	// Never evict live throttle entries during one large scan: doing so would
	// make an attacker-controlled key set churn and re-log every entry.
	if (expiredL2WarningTimes.size >= MAX_EXPIRED_L2_WARNING_KEYS) return false;
	expiredL2WarningTimes.set(key, nowMs);
	return true;
}
