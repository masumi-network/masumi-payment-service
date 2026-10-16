import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import {
	Network,
	PaymentAction,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import { hydraValidityUpperBoundTimeMs } from '@/services/hydra-connection-manager/hydra-transaction-evidence';
import { convertNetwork } from '@/utils/converter/network-convert';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import { fetchHydraConfirmedSnapshotNumber } from '@/lib/hydra/hydra/node-control-queries';
import { decideL2ReservationRelease } from './l2-reservation-release-decision';
import { paymentL2ActionRetry, purchaseL2ActionRetry, releaseRejectedL2Reservation } from './l2-reservation-release';
import { nudgeIdleHeadForRelease, type L2ReleaseNudgeCandidate } from './l2-reservation-nudge';

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
const MAX_RELEASE_BASELINES = 10_000;
/** Baselines for heads no longer scanned (closed, disabled) are dropped after this. */
const RELEASE_BASELINE_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * Transaction id → the node's own confirmed snapshot number read after expiry.
 * Losing it on restart only delays release. Pruned on every scan of its head.
 */
const releaseBaselines = new Map<string, { hydraHeadId: string; snapshotNumber: bigint; recordedAtMs: number }>();

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
 * is released only on the input proof in `decideL2ReservationRelease`: every
 * input unspent in a verified snapshot newer than the node's own confirmed
 * snapshot read after expiry. Everything else stays fail-closed and reported.
 */
export async function reportExpiredL2Reservations(params: {
	hydraHeadId: string;
	network: Network;
	node: HydraNode;
	nowMs?: number;
	database?: typeof prisma;
	/** Makes an idle head confirm the newer snapshot release waits for. */
	nudge?: (candidate: L2ReleaseNudgeCandidate) => Promise<unknown>;
}): Promise<number> {
	const { hydraHeadId, network, node, nowMs = Date.now(), database = prisma } = params;
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
			l2ReleaseNudgeInputRef: true,
			l2ReservationPreviousLayer: true,
			l2ReservationPreviousSmartContractWalletId: true,
			l2ReservationPreviousBuyerReturnAddress: true,
			l2ReservationPreviousCollateralReturn: true,
			l2ReservationPreviousTransactionId: true,
			PaymentRequestCurrent: { select: escrowPointerSelect },
			PurchaseRequestCurrent: { select: escrowPointerSelect },
		},
	});
	pruneReleaseBaselines(hydraHeadId, new Set(candidates.map((candidate) => candidate.id)), nowMs);

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
		// verified-snapshot input proof does. The proof reads the node's own
		// verified snapshot: snapshot confirmations never advance the persisted tip.
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
				graceMs: L2_RESERVATION_RELEASE_GRACE_MS,
			}) &&
			(await releaseIfProvenDead(
				{ ...candidate, l2ReservationInputRefs: reservationInputRefs(candidate) },
				verifiedSnapshotNumber,
				node,
				hydraHeadId,
				database,
				nowMs,
				nudge,
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

const escrowPointerSelect = {
	currentHydraUtxoTxHash: true,
	currentHydraUtxoOutputIndex: true,
	NextAction: { select: { requestedAction: true } },
} as const;

type EscrowPointer = {
	currentHydraUtxoTxHash: string | null;
	currentHydraUtxoOutputIndex: number | null;
};

/**
 * The inputs the release proof checks. Rows from the non-locking actions made
 * before `reserveL2Action` recorded inputs have none, and would pin their
 * wallet for good. Their body spends the request's escrow UTxO, which the
 * request still names while the body is unconfirmed, and one input unspent
 * after expiry is proof enough: an applied body spends every input.
 *
 * Used only while that pointer cannot name this body's own output. Once replay
 * moves it to the body's output, an unspent pointer proves the opposite.
 *
 * The body's other inputs are unknown, so the nudge may pick one of them. That
 * is safe: the body is expired, and a nudge that conflicts with a body still in
 * the local ledger is refused, and its recorded input then keeps release waiting.
 *
 * A row this cannot derive for (no current request, a pointer already spent)
 * stays held for an operator. That fails closed.
 */
function reservationInputRefs(candidate: {
	intendedTxHash: string | null;
	l2ReservationInputRefs: string[];
	PaymentRequestCurrent: Array<EscrowPointer & { NextAction: { requestedAction: PaymentAction } | null }>;
	PurchaseRequestCurrent: Array<EscrowPointer & { NextAction: { requestedAction: PurchasingAction } | null }>;
}): string[] {
	if (candidate.l2ReservationInputRefs.length > 0) return candidate.l2ReservationInputRefs;
	const requests: EscrowPointer[] = [
		...candidate.PaymentRequestCurrent.filter(
			(request) => paymentL2ActionRetry(request.NextAction?.requestedAction) !== undefined,
		),
		...candidate.PurchaseRequestCurrent.filter(
			(request) => purchaseL2ActionRetry(request.NextAction?.requestedAction) !== undefined,
		),
	];
	if (requests.length !== 1 || candidate.PaymentRequestCurrent.length + candidate.PurchaseRequestCurrent.length !== 1) {
		return [];
	}
	const { currentHydraUtxoTxHash: txHash, currentHydraUtxoOutputIndex: outputIndex } = requests[0];
	if (txHash == null || outputIndex == null || candidate.intendedTxHash == null) return [];
	if (txHash.toLowerCase() === candidate.intendedTxHash.toLowerCase()) return [];
	return [`${txHash}#${outputIndex}`.toLowerCase()];
}

function pruneExpiredL2WarningThrottle(nowMs: number): void {
	for (const [key, warnedAtMs] of expiredL2WarningTimes) {
		if (warnedAtMs > nowMs || nowMs - warnedAtMs >= EXPIRED_L2_RESERVATION_WARNING_INTERVAL_MS) {
			expiredL2WarningTimes.delete(key);
		}
	}
}

async function releaseIfProvenDead(
	candidate: Parameters<typeof releaseRejectedL2Reservation>[0] & {
		intendedTxHash: string | null;
		l2ReservationInputRefs: string[];
		l2ReleaseNudgeInputRef?: string | null;
	},
	snapshotNumber: bigint,
	node: HydraNode,
	hydraHeadId: string,
	database: typeof prisma,
	nowMs: number,
	nudge: (candidate: L2ReleaseNudgeCandidate) => Promise<unknown>,
): Promise<boolean> {
	const nudgeInputRef = candidate.l2ReleaseNudgeInputRef ?? null;
	const decision = decideL2ReservationRelease({
		inputRefs: candidate.l2ReservationInputRefs,
		nudgeInputRef,
		snapshotNumber,
		baselineSnapshotNumber: releaseBaselines.get(candidate.id)?.snapshotNumber,
		readVerifiedOutput: (reference, number) => node.getVerifiedCurrentOutput(reference, number),
		isPendingCommit: (reference, number) => node.isVerifiedPendingCommitOutput(reference, number),
	});
	if (decision.action === 'baseline') {
		await recordReleaseBaseline(candidate.id, hydraHeadId, decision.snapshotNumber, node, nowMs);
		return false;
	}
	if (decision.action === 'await-snapshot') {
		await nudge({
			id: candidate.id,
			l2ReservationInputRefs: candidate.l2ReservationInputRefs,
			l2ReleaseNudgeInputRef: nudgeInputRef,
		});
		return false;
	}
	if (decision.action !== 'release') return false;
	const released = await releaseRejectedL2Reservation(candidate, database, 'inputs-unspent-after-expiry');
	releaseBaselines.delete(candidate.id);
	if (released) {
		logger.warn('[HydraReconcile] released expired L2 reservation: every input unspent after expiry', {
			hydraHeadId,
			transactionId: candidate.id,
			intendedTxHash: candidate.intendedTxHash,
			snapshotNumber: snapshotNumber.toString(),
		});
	}
	return released;
}

/**
 * Record the node's own confirmed snapshot number as the release baseline. Read
 * from the node, not from replay or the DB, which can both lag it.
 */
async function recordReleaseBaseline(
	transactionId: string,
	hydraHeadId: string,
	verifiedSnapshotNumber: bigint,
	node: HydraNode,
	nowMs: number,
): Promise<void> {
	if (releaseBaselines.size >= MAX_RELEASE_BASELINES) {
		logger.warn('[HydraReconcile] L2 release baseline table full; auto-release paused', { hydraHeadId, transactionId });
		return;
	}
	let nodeSnapshot: { headId: string; number: bigint };
	try {
		nodeSnapshot = await fetchHydraConfirmedSnapshotNumber(node);
	} catch (error) {
		logger.warn('[HydraReconcile] could not read node snapshot for L2 release baseline', { hydraHeadId, error });
		return;
	}
	if (node.expectedHeadId == null || nodeSnapshot.headId !== node.expectedHeadId) return;
	releaseBaselines.set(transactionId, {
		hydraHeadId,
		snapshotNumber: nodeSnapshot.number > verifiedSnapshotNumber ? nodeSnapshot.number : verifiedSnapshotNumber,
		recordedAtMs: nowMs,
	});
}

function pruneReleaseBaselines(hydraHeadId: string, liveTransactionIds: ReadonlySet<string>, nowMs: number): void {
	for (const [transactionId, baseline] of releaseBaselines) {
		if (
			(baseline.hydraHeadId === hydraHeadId && !liveTransactionIds.has(transactionId)) ||
			nowMs - baseline.recordedAtMs > RELEASE_BASELINE_MAX_AGE_MS
		) {
			releaseBaselines.delete(transactionId);
		}
	}
}

function shouldWarnExpiredL2Reservation(key: string, nowMs: number): boolean {
	if (expiredL2WarningTimes.has(key)) return false;
	// Never evict live throttle entries during one large scan: doing so would
	// make an attacker-controlled key set churn and re-log every entry.
	if (expiredL2WarningTimes.size >= MAX_EXPIRED_L2_WARNING_KEYS) return false;
	expiredL2WarningTimes.set(key, nowMs);
	return true;
}
