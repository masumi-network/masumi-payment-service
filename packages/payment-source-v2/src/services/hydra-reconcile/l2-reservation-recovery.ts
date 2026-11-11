import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { Network, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import { fetchHydraSnapshotRound, type HydraSnapshotRound } from '@/lib/hydra/hydra/node-control-queries';
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
 * Slack past expiry before an action reservation may be released. An action has
 * no release nudge to confirm the body dead, so it waits as long as an admin
 * does for a row automatic recovery can prove (`L2_OPERATOR_RELEASE_GRACE_MS`).
 */
export const L2_ACTION_RELEASE_GRACE_MS = L2_RESERVATION_RELEASE_GRACE_MS + 5 * L2_RELEASE_NUDGE_INTERVAL_MS;

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
 * is released only once its own release nudge, which spends the body's wallet
 * inputs, shows up in a verified snapshot (`./l2-release-nudge-proof`).
 * Everything else stays fail-closed and reported.
 */
export async function reportExpiredL2Reservations(params: {
	hydraHeadId: string;
	network: Network;
	node: HydraNode;
	nowMs?: number;
	database?: typeof prisma;
	/** Makes an idle head confirm the newer snapshot release waits for. */
	nudge?: (candidate: L2ReleaseNudgeCandidate) => Promise<unknown>;
	/** The node's snapshot round in flight; an action is released only while none is. */
	readSnapshotRound?: () => Promise<HydraSnapshotRound>;
}): Promise<number> {
	const { hydraHeadId, network, node, nowMs = Date.now(), database = prisma } = params;
	const readSnapshotRound = params.readSnapshotRound ?? (() => fetchHydraSnapshotRound(node));
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
		if (
			verifiedSnapshotNumber !== undefined &&
			canReportExpiredL2Reservation({
				hasVerifiedPinnedSessions: node.hasVerifiedPinnedSessions,
				historyReady: node.confirmedTransactionHistoryReady,
				queuedTransactions: node.getConfirmedTransactionsForReconciliation().length,
				headClock: node.headClock,
				nowMs,
				validityUpperBoundTimeMs,
				graceMs:
					candidate.l2ReservationPreviousTransactionId === null
						? L2_RESERVATION_RELEASE_GRACE_MS
						: L2_ACTION_RELEASE_GRACE_MS,
			}) &&
			(await releaseIfProvenDead(
				candidate,
				verifiedSnapshotNumber,
				node,
				hydraHeadId,
				database,
				nudge,
				readSnapshotRound,
			))
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
	readSnapshotRound: () => Promise<HydraSnapshotRound>,
): Promise<boolean> {
	// An action has no value floor and its escrow input is a script UTxO the
	// wallet cannot nudge-spend, so it is judged on the head's own state instead.
	if (candidate.l2ReservationPreviousTransactionId !== null) {
		return await releaseActionIfBodyUnapplied(candidate, node, hydraHeadId, database, readSnapshotRound);
	}
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
 * refund, submit a result, collect, ...) whose body provably cannot apply and
 * has not. Fail-closed: every unknown retains. It needs, all at once:
 *
 * - the body is past its validity bound plus `L2_ACTION_RELEASE_GRACE_MS` on a
 *   fresh head clock (the caller's gate), so no snapshot request made now can
 *   still include it;
 * - our node shows no snapshot round in flight, so none signed before expiry
 *   can still confirm it;
 * - the body is in no confirmed history;
 * - EVERY input the body spends, the escrow included, is still in the node's
 *   verified current snapshot. A body applies atomically, so one that applied
 *   has spent all of them.
 *
 * Unlike a lock's nudge proof this reads the node's reference mapping, which is
 * the configured local-node trust (`readVerifiedCurrentOutput`). That is
 * acceptable here only because a wrong release of an action moves no funds: it
 * returns the request to its retry action, a retry spends an escrow output that
 * can be spent once, and a wrong release is undone by the admin re-apply. So the
 * row is stamped like an operator release (`l2ReleasedByOperatorAt`), never as
 * an input proof, whose later confirmation the re-apply refuses. An initial lock
 * never takes this path: its double-lock risk needs the nudge proof.
 */
async function releaseActionIfBodyUnapplied(
	candidate: Parameters<typeof releaseRejectedL2Reservation>[0] & {
		intendedTxHash: string | null;
		l2ReservationInputRefs: string[];
	},
	node: HydraNode,
	hydraHeadId: string,
	database: typeof prisma,
	readSnapshotRound: () => Promise<HydraSnapshotRound>,
): Promise<boolean> {
	const { intendedTxHash, l2ReservationInputRefs: inputRefs } = candidate;
	if (intendedTxHash === null || inputRefs.length === 0) return false;
	let round: HydraSnapshotRound;
	try {
		round = await readSnapshotRound();
	} catch (error) {
		logger.warn('[HydraReconcile] could not read the snapshot round for an expired L2 action; reservation stays held', {
			hydraHeadId,
			transactionId: candidate.id,
			error: error instanceof Error ? error.message : error,
		});
		return false;
	}
	// Read after the round, with no await in between: a round that confirms
	// meanwhile moves the snapshot number and leaves the inputs unread.
	const snapshotNumber = node.verifiedSnapshotNumber;
	if (
		round.inFlight ||
		snapshotNumber === undefined ||
		node.getConfirmedTransaction(intendedTxHash) ||
		!inputRefs.every((reference) => node.getVerifiedCurrentOutput(reference, snapshotNumber) !== null)
	) {
		return false;
	}
	const released = await releaseRejectedL2Reservation(candidate, database, 'unspent-inputs');
	if (released) {
		logger.warn('[HydraReconcile] released expired L2 action reservation: its body cannot apply and did not', {
			hydraHeadId,
			transactionId: candidate.id,
			intendedTxHash,
			snapshotNumber: snapshotNumber.toString(),
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
