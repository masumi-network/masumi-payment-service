/**
 * The admin path for an expired L2 reservation that automatic recovery cannot
 * release.
 *
 * Automatic recovery releases only on proof: the reservation's own release
 * nudge in a verified snapshot (`./l2-release-nudge-proof`). Some reservations
 * can never get that proof. The nudge is refused forever when another
 * transaction already spent one of the body's inputs. A withdrawal can spend the
 * nudge's output before release reads it. A row with no value floor (a
 * non-locking action) is never nudged at all. Each one pins its wallet until an
 * admin decides.
 *
 * The admin decision is not a proof. The one thing it cannot rule out is that
 * the body applied in a snapshot the node withheld. A release then lets the
 * purchase lock a second time. So this path checks everything it can (the
 * head is open, the body has expired past the release grace on the head's own
 * clock, and our node shows no confirmation of it), requires the caller to
 * acknowledge the rest, and marks the row `l2ReleasedByOperatorAt`: a later
 * confirmation of the body halts the head's replay instead of being applied.
 */
import createHttpError from 'http-errors';
import { HydraHeadStatus, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import { readHydraSignedTransactionShape } from '@/lib/hydra/hydra/signed-transaction-shape';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { hydraValidityUpperBoundTimeMs } from '@/services/hydra-connection-manager/hydra-transaction-evidence';
import { convertNetwork } from '@/utils/converter/network-convert';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import { canReportExpiredL2Reservation, L2_RESERVATION_RELEASE_GRACE_MS } from './l2-reservation-recovery';
import { releaseRejectedL2Reservation } from './l2-reservation-release';

export type HeldL2Reservation = {
	transactionId: string;
	/** Echo it back to release: the release is refused if the row changed. */
	updatedAt: Date;
	intendedTxHash: string | null;
	/** The body's validity upper bound, as head time. */
	expiresAt: Date | null;
	kind: 'initial-lock' | 'action';
	purchaseRequestIds: string[];
	paymentRequestIds: string[];
	walletAddress: string | null;
	inputRefs: string[];
	/**
	 * Body inputs our node maps to an output in its verified snapshot. Read
	 * from the local node's reference map, so it is a hint for the admin and
	 * never evidence.
	 */
	inputsReportedUnspent: number | null;
	/** Hash of the recorded release nudge, if one was recorded. */
	releaseNudgeTxHash: string | null;
	rejectedByHeadReason: string | null;
	releasable: boolean;
	/** Why `releasable` is false; null when it is true. */
	blockedReason: string | null;
};

const reservationSelect = {
	id: true,
	updatedAt: true,
	status: true,
	layer: true,
	txHash: true,
	hydraHeadId: true,
	intendedTxHash: true,
	invalidHereafterSlot: true,
	l2ReservationInputRefs: true,
	l2ReleaseNudgeTx: true,
	l2RejectedByHeadReason: true,
	l2ReservationPreviousLayer: true,
	l2ReservationPreviousSmartContractWalletId: true,
	l2ReservationPreviousBuyerReturnAddress: true,
	l2ReservationPreviousCollateralReturn: true,
	l2ReservationPreviousTransactionId: true,
	PurchaseRequestCurrent: { select: { id: true } },
	PaymentRequestCurrent: { select: { id: true } },
	BlocksWallet: { select: { walletAddress: true } },
} as const;

type ReservationRow = {
	id: string;
	updatedAt: Date;
	txHash: string | null;
	intendedTxHash: string | null;
	invalidHereafterSlot: bigint | null;
	l2ReservationInputRefs: string[];
	l2ReleaseNudgeTx: string | null;
	l2RejectedByHeadReason: string | null;
	l2ReservationPreviousTransactionId: string | null;
	PurchaseRequestCurrent: Array<{ id: string }>;
	PaymentRequestCurrent: Array<{ id: string }>;
	BlocksWallet: { walletAddress: string } | null;
};

async function loadHead(headId: string) {
	const head = await prisma.hydraHead.findUnique({
		where: { id: headId },
		select: {
			id: true,
			status: true,
			isClosing: true,
			ownerEpoch: true,
			HydraRelation: { select: { network: true } },
		},
	});
	if (!head) throw createHttpError(404, 'Hydra head not found');
	return head;
}

/** Why this reservation cannot be released now, or null when it can. */
function blockedReason(row: ReservationRow, node: HydraNode | null, expiresAtMs: bigint | null, nowMs: number) {
	if (row.txHash != null) return 'The body was accepted by the head (it has a txHash); it is not a dead reservation';
	if (!node) return 'No live connection to the head, so its clock and history cannot be checked';
	if (row.intendedTxHash != null && node.getConfirmedTransaction(row.intendedTxHash)) {
		return 'Our node shows this body confirmed; the normal replay will settle it';
	}
	const expired = canReportExpiredL2Reservation({
		hasVerifiedPinnedSessions: node.hasVerifiedPinnedSessions,
		historyReady: node.confirmedTransactionHistoryReady,
		queuedTransactions: node.getConfirmedTransactionsForReconciliation().length,
		headClock: node.headClock,
		nowMs,
		validityUpperBoundTimeMs: expiresAtMs,
		graceMs: L2_RESERVATION_RELEASE_GRACE_MS,
	});
	if (!expired) {
		return 'Not provably expired yet: the body must be past its validity bound plus the release grace on a fresh head clock, with history verified and replayed';
	}
	return null;
}

function toHeld(row: ReservationRow, node: HydraNode | null, slotConfig: SlotConfig, nowMs: number): HeldL2Reservation {
	const expiresAtMs =
		row.invalidHereafterSlot == null || !slotConfig
			? null
			: hydraValidityUpperBoundTimeMs({ validityUpperSlot: row.invalidHereafterSlot }, slotConfig);
	const snapshotNumber = node?.verifiedSnapshotNumber;
	const reason = blockedReason(row, node, expiresAtMs, nowMs);
	return {
		transactionId: row.id,
		updatedAt: row.updatedAt,
		intendedTxHash: row.intendedTxHash,
		expiresAt: expiresAtMs == null ? null : new Date(Number(expiresAtMs)),
		kind: row.l2ReservationPreviousTransactionId == null ? 'initial-lock' : 'action',
		purchaseRequestIds: row.PurchaseRequestCurrent.map((purchase) => purchase.id),
		paymentRequestIds: row.PaymentRequestCurrent.map((payment) => payment.id),
		walletAddress: row.BlocksWallet?.walletAddress ?? null,
		inputRefs: row.l2ReservationInputRefs,
		inputsReportedUnspent:
			node && snapshotNumber !== undefined
				? row.l2ReservationInputRefs.filter(
						(reference) => node.getVerifiedCurrentOutput(reference, snapshotNumber) !== null,
					).length
				: null,
		releaseNudgeTxHash:
			row.l2ReleaseNudgeTx == null ? null : (readHydraSignedTransactionShape(row.l2ReleaseNudgeTx)?.txHash ?? null),
		rejectedByHeadReason: row.l2RejectedByHeadReason,
		releasable: reason === null,
		blockedReason: reason,
	};
}

type SlotConfig = ReturnType<typeof resolveHydraL2EvidenceSlotConfig>;

const pendingOnHead = (headId: string) => ({
	hydraHeadId: headId,
	layer: TransactionLayer.L2,
	status: TransactionStatus.Pending,
	intendedTxHash: { not: null },
});

/** Pending L2 reservations on the head, each with whether an admin may release it now. */
export async function listHeldL2Reservations(
	headId: string,
	nowMs = Date.now(),
): Promise<{ headId: string; reservations: HeldL2Reservation[] }> {
	const head = await loadHead(headId);
	const node = head.status === HydraHeadStatus.Open ? getHydraConnectionManager().getNode(head.id) : null;
	const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(head.HydraRelation.network));
	const rows = await prisma.transaction.findMany({
		where: pendingOnHead(head.id),
		select: reservationSelect,
		orderBy: { createdAt: 'asc' },
	});
	return { headId: head.id, reservations: rows.map((row) => toHeld(row, node, slotConfig, nowMs)) };
}

/**
 * Release one expired L2 reservation on an admin's decision. Re-checks every
 * precondition against live state; the caller only says which row it reviewed.
 */
export async function releaseHeldL2Reservation(params: {
	headId: string;
	transactionId: string;
	expectedUpdatedAt: Date;
	actorApiKeyId: string;
	nowMs?: number;
}): Promise<{ transactionId: string; purchaseRequestIds: string[]; paymentRequestIds: string[] }> {
	const { headId, transactionId, expectedUpdatedAt, actorApiKeyId, nowMs = Date.now() } = params;
	const head = await loadHead(headId);
	if (head.status !== HydraHeadStatus.Open) throw createHttpError(409, `Head status is ${head.status}, expected Open`);
	if (head.isClosing) throw createHttpError(409, 'The head is closing; its final snapshot settles the reservation');
	const node = getHydraConnectionManager().getNode(head.id);
	if (!node) throw createHttpError(502, 'No active connection to Hydra head');

	const row = await prisma.transaction.findFirst({
		where: { id: transactionId, ...pendingOnHead(head.id) },
		select: reservationSelect,
	});
	if (!row) throw createHttpError(404, 'No pending L2 reservation with this id on this head');
	if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
		throw createHttpError(409, 'The reservation changed since it was shown; reload and review it again');
	}
	const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(head.HydraRelation.network));
	const held = toHeld(row, node, slotConfig, nowMs);
	if (!held.releasable) throw createHttpError(409, held.blockedReason ?? 'The reservation cannot be released now');

	// The checks above awaited the database. The session must still be the one
	// they read, or a reconnect could have replayed a confirmation of the body.
	if (getHydraConnectionManager().getNode(head.id) !== node) {
		throw createHttpError(409, 'The head connection changed while the release was checked; reload and retry');
	}
	logger.warn('[HydraReconcile] admin is releasing an L2 reservation without a release proof', {
		hydraHeadId: head.id,
		transactionId: row.id,
		intendedTxHash: row.intendedTxHash,
		actorApiKeyId,
		releaseNudgeTxHash: held.releaseNudgeTxHash,
		inputsReportedUnspent: held.inputsReportedUnspent,
		inputCount: row.l2ReservationInputRefs.length,
	});
	// Guarded on the nudge it read: one recorded since then may still apply.
	const released = await releaseRejectedL2Reservation(row, prisma, 'operator');
	if (!released) {
		throw createHttpError(
			409,
			'The reservation was not released: it changed, or a request on it is in an action that cannot be restored automatically',
		);
	}
	return {
		transactionId: row.id,
		purchaseRequestIds: held.purchaseRequestIds,
		paymentRequestIds: held.paymentRequestIds,
	};
}
