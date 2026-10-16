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
import { isL2ReservationSpentByNudge } from './l2-release-nudge-proof';
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
			l2ReleaseNudgeTx: true,
			l2ReservationPreviousLayer: true,
			l2ReservationPreviousSmartContractWalletId: true,
			l2ReservationPreviousBuyerReturnAddress: true,
			l2ReservationPreviousCollateralReturn: true,
			l2ReservationPreviousTransactionId: true,
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
				graceMs: L2_RESERVATION_RELEASE_GRACE_MS,
			}) &&
			(await releaseIfProvenDead(candidate, verifiedSnapshotNumber, node, hydraHeadId, database, nudge))
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

export const escrowPointerSelect = {
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
export function reservationInputRefs(candidate: {
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
		l2ReleaseNudgeTx: string | null;
	},
	snapshotNumber: bigint,
	node: HydraNode,
	hydraHeadId: string,
	database: typeof prisma,
	nudge: (candidate: L2ReleaseNudgeCandidate) => Promise<unknown>,
): Promise<boolean> {
	// Reservations made before inputs were recorded cannot be proven dead.
	if (candidate.l2ReservationInputRefs.length === 0) return false;
	const spentByNudge = isL2ReservationSpentByNudge({
		nudgeTx: candidate.l2ReleaseNudgeTx,
		inputRefs: candidate.l2ReservationInputRefs,
		readOutput: (reference) => node.getVerifiedCurrentOutput(reference, snapshotNumber),
	});
	if (!spentByNudge) {
		await nudge({
			id: candidate.id,
			l2ReservationInputRefs: candidate.l2ReservationInputRefs,
			l2ReleaseNudgeTx: candidate.l2ReleaseNudgeTx,
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

function shouldWarnExpiredL2Reservation(key: string, nowMs: number): boolean {
	if (expiredL2WarningTimes.has(key)) return false;
	// Never evict live throttle entries during one large scan: doing so would
	// make an attacker-controlled key set churn and re-log every entry.
	if (expiredL2WarningTimes.size >= MAX_EXPIRED_L2_WARNING_KEYS) return false;
	expiredL2WarningTimes.set(key, nowMs);
	return true;
}
