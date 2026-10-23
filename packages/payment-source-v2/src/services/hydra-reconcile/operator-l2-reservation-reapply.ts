/**
 * The admin path for a released L2 reservation whose body confirmed anyway.
 *
 * A release, on the input proof or by an admin, marks the row so that a later
 * confirmation of its body holds the head's replay instead of being applied
 * (`head-tx-confirmed`). The head then shows `replay-apply-retry` on that body
 * and every later confirmation waits behind it.
 *
 * For an action an admin released, the body spends the escrow output the
 * request still points at. That output is single-use, so the body confirming
 * means no retry of the action can, and the request is still where the
 * release left it. This path
 * checks that, then puts the row and each request back exactly where the
 * reservation had them: the row Pending, the request's current transaction
 * the row, its next action the in-flight one. The next replay pass applies the
 * body the normal way, and the batcher never sees a retry action to rebuild.
 *
 * An initial lock is refused. Its release returned the purchase to locking
 * and overwrote the purchase fields the body's datum was built from, and the
 * purchase may already be locked again. A release on the input proof is
 * refused too: that proof says the body can never confirm, so a confirmation
 * means the proof failed. Both need a person, not a button.
 */
import createHttpError from 'http-errors';
import {
	PaymentAction,
	Prisma,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { CONSTANTS } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { parseHydraTransactionEvidence } from '@/services/hydra-connection-manager/hydra-transaction-evidence';
import { connectPreviousAction, createNextPaymentAction, createNextPurchaseAction } from '@/services/shared';
import { paymentL2ActionRetry, purchaseL2ActionRetry } from './l2-reservation-release';
import { REPLAY_APPLY_RETRY_REASON } from './replay-stall-reason';

export type StalledReleasedL2Reservation = {
	transactionId: string;
	/** Echo it back to re-apply: the call is refused if the row changed. */
	updatedAt: Date;
	intendedTxHash: string;
	releasedBy: 'input-proof' | 'operator';
	releasedAt: Date;
	kind: 'initial-lock' | 'action';
	purchaseRequestIds: string[];
	paymentRequestIds: string[];
	reapplicable: boolean;
	/** Why `reapplicable` is false; null when it is true. */
	blockedReason: string | null;
};

const requestSelect = {
	id: true,
	layer: true,
	nextActionId: true,
	currentTransactionId: true,
	currentHydraUtxoTxHash: true,
	currentHydraUtxoOutputIndex: true,
} as const;

const actionSelect = { id: true, createdAt: true, requestedAction: true } as const;
// `id` breaks createdAt ties so the order is fixed.
const historyOrder: Array<{ createdAt?: Prisma.SortOrder; id?: Prisma.SortOrder }> = [
	{ createdAt: 'asc' },
	{ id: 'asc' },
];

const releasedRowSelect = {
	id: true,
	createdAt: true,
	updatedAt: true,
	status: true,
	txHash: true,
	intendedTxHash: true,
	previousOnChainState: true,
	newOnChainState: true,
	l2ReleasedByInputProofAt: true,
	l2ReleasedByOperatorAt: true,
	l2ReservationPreviousActionId: true,
	l2ReservationPreviousTransactionId: true,
	BlocksWallet: { select: { id: true } },
	// Oldest first: the release moved the in-flight action into ActionHistory,
	// and everything created after it shows what happened to the request since.
	PaymentRequestHistory: {
		select: {
			...requestSelect,
			NextAction: { select: { requestedAction: true, resultHash: true } },
			ActionHistory: { orderBy: historyOrder, select: { ...actionSelect, resultHash: true } },
		},
	},
	PurchaseRequestHistory: {
		select: {
			...requestSelect,
			NextAction: { select: { requestedAction: true } },
			ActionHistory: { orderBy: historyOrder, select: actionSelect },
		},
	},
} as const;

type ReleasedRow = Prisma.TransactionGetPayload<{ select: typeof releasedRowSelect }>;

const releasedOnHead = (headId: string, intendedTxHash: string) => ({
	hydraHeadId: headId,
	layer: TransactionLayer.L2,
	status: TransactionStatus.RolledBack,
	intendedTxHash,
	OR: [{ l2ReleasedByInputProofAt: { not: null } }, { l2ReleasedByOperatorAt: { not: null } }],
});

async function loadHead(headId: string) {
	const head = await prisma.hydraHead.findUnique({
		where: { id: headId },
		select: { id: true, reconciliationStalledTxId: true, reconciliationStalledReason: true },
	});
	if (!head) throw createHttpError(404, 'Hydra head not found');
	return head;
}

/** The released row replay is held on, if the head is held on one. */
async function findHeldRow(head: Awaited<ReturnType<typeof loadHead>>): Promise<ReleasedRow | null> {
	if (head.reconciliationStalledReason !== REPLAY_APPLY_RETRY_REASON || head.reconciliationStalledTxId == null) {
		return null;
	}
	return await prisma.transaction.findFirst({
		where: releasedOnHead(head.id, head.reconciliationStalledTxId),
		select: releasedRowSelect,
	});
}

type ActionEntry<Action> = { requestedAction: Action; resultHash?: string | null };
type HistoryEntry<Action> = ActionEntry<Action> & { id: string; createdAt: Date };

/**
 * The in-flight action the release replaced, or null when the request was
 * moved on since. The restored action must be that one, so the body's
 * confirmation maps to the action and result hash it carried.
 *
 * The reservation created that action in the same transaction as the row, so
 * it is the oldest in-flight action not older than the row. Earlier attempts
 * are older; anything later was created after the release. It must be the
 * in-flight form of the action the reservation recorded as the one it
 * replaced.
 *
 * Every action created after it, and the current one, must be its retry with
 * the same result hash, or the parking that failed retries against the spent
 * escrow output end in. Anything else means someone moved the request on.
 */
function releasedInFlightAction<Action extends string>(
	row: { createdAt: Date; l2ReservationPreviousActionId: string | null },
	historyOldestFirst: Array<HistoryEntry<Action>>,
	next: ActionEntry<Action>,
	retryOf: (action: Action) => Action | undefined,
	parked: Action,
): ActionEntry<Action> | null {
	const replaced = historyOldestFirst.find((entry) => entry.id === row.l2ReservationPreviousActionId);
	const index = historyOldestFirst.findIndex(
		(entry) => entry.createdAt >= row.createdAt && retryOf(entry.requestedAction) !== undefined,
	);
	if (replaced === undefined || index < 0) return null;
	const released = historyOldestFirst[index];
	const retry = retryOf(released.requestedAction);
	if (retry !== replaced.requestedAction) return null;
	const isLeftAsReleased = (entry: ActionEntry<Action>) =>
		entry.requestedAction === parked ||
		(entry.requestedAction === retry && (entry.resultHash ?? null) === (released.resultHash ?? null));
	return [...historyOldestFirst.slice(index + 1), next].every(isLeftAsReleased) ? released : null;
}

const releasedPaymentAction = (row: ReleasedRow, payment: ReleasedRow['PaymentRequestHistory'][number]) =>
	releasedInFlightAction(
		row,
		payment.ActionHistory,
		payment.NextAction,
		paymentL2ActionRetry,
		PaymentAction.WaitingForManualAction,
	);

const releasedPurchaseAction = (row: ReleasedRow, purchase: ReleasedRow['PurchaseRequestHistory'][number]) =>
	releasedInFlightAction(
		row,
		purchase.ActionHistory,
		purchase.NextAction,
		purchaseL2ActionRetry,
		PurchasingAction.WaitingForManualAction,
	);

const INITIAL_LOCK_REASON =
	'An initial lock: its release sent the purchase back to locking and it may be locked again. Resolve it by hand';

const INPUT_PROOF_REASON =
	'Released on an input proof, which says this body can never confirm. The proof failed; investigate before anything else';

/** Why the body cannot be re-applied now, or null when it can. */
function blockedReason(row: ReleasedRow, node: HydraNode | null): string | null {
	if (row.txHash != null || row.previousOnChainState != null || row.newOnChainState != null) {
		return 'The row already records an accepted or observed transaction; it is not a plain release';
	}
	const previousTransactionId = row.l2ReservationPreviousTransactionId;
	if (previousTransactionId == null) return INITIAL_LOCK_REASON;
	if (row.l2ReleasedByInputProofAt != null) return INPUT_PROOF_REASON;
	if (row.BlocksWallet != null) return 'A wallet is still reserved by this row';
	if (!node) return 'No live connection to the head, so its confirmed history cannot be checked';
	const confirmed = row.intendedTxHash == null ? null : node.getConfirmedTransaction(row.intendedTxHash);
	if (!confirmed) return 'Our node does not show this body confirmed';
	const evidence = parseHydraTransactionEvidence(confirmed.cborHex);
	if (!evidence || evidence.txHash !== row.intendedTxHash) return 'The confirmed body could not be parsed';

	const requests = [...row.PaymentRequestHistory, ...row.PurchaseRequestHistory];
	if (requests.length === 0) return 'No request carries this reservation';
	for (const request of requests) {
		if (request.currentTransactionId !== previousTransactionId || request.layer !== TransactionLayer.L2) {
			return `Request ${request.id} has moved on since the release (a retry may be in flight); wait for it to settle`;
		}
		const spendsEscrow = evidence.inputs.some(
			(input) =>
				input.txHash === request.currentHydraUtxoTxHash && input.outputIndex === request.currentHydraUtxoOutputIndex,
		);
		if (!spendsEscrow) return `The confirmed body does not spend the escrow output request ${request.id} points at`;
	}
	for (const payment of row.PaymentRequestHistory) {
		if (!releasedPaymentAction(row, payment)) return `Payment ${payment.id} was moved on since its release`;
	}
	for (const purchase of row.PurchaseRequestHistory) {
		if (!releasedPurchaseAction(row, purchase)) return `Purchase ${purchase.id} was moved on since its release`;
	}
	return null;
}

function toStalled(row: ReleasedRow, node: HydraNode | null): StalledReleasedL2Reservation {
	const reason = blockedReason(row, node);
	return {
		transactionId: row.id,
		updatedAt: row.updatedAt,
		// Both are guaranteed by `releasedOnHead`, which selected the row.
		intendedTxHash: row.intendedTxHash!,
		releasedBy: row.l2ReleasedByInputProofAt != null ? 'input-proof' : 'operator',
		releasedAt: (row.l2ReleasedByInputProofAt ?? row.l2ReleasedByOperatorAt)!,
		kind: row.l2ReservationPreviousTransactionId == null ? 'initial-lock' : 'action',
		purchaseRequestIds: row.PurchaseRequestHistory.map((purchase) => purchase.id),
		paymentRequestIds: row.PaymentRequestHistory.map((payment) => payment.id),
		reapplicable: reason === null,
		blockedReason: reason,
	};
}

/** The released reservation the head's replay is held on, or null when it is not held on one. */
export async function findStalledReleasedL2Reservation(
	headId: string,
): Promise<{ headId: string; reservation: StalledReleasedL2Reservation | null }> {
	const head = await loadHead(headId);
	const row = await findHeldRow(head);
	const node = row ? getHydraConnectionManager().getNode(head.id) : null;
	return { headId: head.id, reservation: row ? toStalled(row, node) : null };
}

/**
 * Undo the release of one reservation whose body confirmed, so replay applies
 * it. Re-checks every precondition against live state; the caller only says
 * which row it reviewed.
 */
export async function reapplyReleasedL2Reservation(params: {
	headId: string;
	transactionId: string;
	expectedUpdatedAt: Date;
	actorApiKeyId: string;
}): Promise<{ transactionId: string; purchaseRequestIds: string[]; paymentRequestIds: string[] }> {
	const { headId, transactionId, expectedUpdatedAt, actorApiKeyId } = params;
	const head = await loadHead(headId);
	const row = await findHeldRow(head);
	if (!row || row.id !== transactionId) {
		throw createHttpError(409, "The head's replay is not held on this released reservation");
	}
	if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
		throw createHttpError(409, 'The reservation changed since it was shown; reload and review it again');
	}
	const node = getHydraConnectionManager().getNode(head.id);
	const stalled = toStalled(row, node);
	if (!stalled.reapplicable) {
		throw createHttpError(409, stalled.blockedReason ?? 'The reservation cannot be re-applied now');
	}
	const previousTransactionId = row.l2ReservationPreviousTransactionId!;

	// The exact inverse of the action branch of `releaseRejectedL2Reservation`.
	// The checks run again on a read inside the transaction, and every write is
	// guarded on that read, so a request that moved in between aborts it.
	const restoreCurrent = {
		CurrentTransaction: { connect: { id: row.id } },
		TransactionHistory: { disconnect: { id: row.id }, connect: { id: previousTransactionId } },
	};
	const requestGuard = (request: { id: string; nextActionId: string }) => ({
		id: request.id,
		nextActionId: request.nextActionId,
		currentTransactionId: previousTransactionId,
		layer: TransactionLayer.L2,
	});
	try {
		await prisma.$transaction(
			async (tx) => {
				const fresh = await tx.transaction.findUnique({ where: { id: row.id }, select: releasedRowSelect });
				if (fresh?.updatedAt.getTime() !== row.updatedAt.getTime() || blockedReason(fresh, node) !== null) {
					throw createHttpError(409, 'The reservation or a request on it changed concurrently; reload and retry');
				}
				await tx.transaction.update({
					where: { id: row.id, updatedAt: row.updatedAt, status: TransactionStatus.RolledBack, txHash: null },
					data: {
						status: TransactionStatus.Pending,
						l2ReleasedByInputProofAt: null,
						l2ReleasedByOperatorAt: null,
					},
				});
				for (const payment of fresh.PaymentRequestHistory) {
					const released = releasedPaymentAction(fresh, payment)!;
					await tx.paymentRequest.update({
						where: requestGuard(payment),
						data: {
							...connectPreviousAction(payment.nextActionId),
							...createNextPaymentAction(
								released.requestedAction,
								released.resultHash == null ? undefined : { resultHash: released.resultHash },
							),
							...restoreCurrent,
						},
					});
				}
				for (const purchase of fresh.PurchaseRequestHistory) {
					await tx.purchaseRequest.update({
						where: requestGuard(purchase),
						data: {
							...connectPreviousAction(purchase.nextActionId),
							...createNextPurchaseAction(releasedPurchaseAction(fresh, purchase)!.requestedAction),
							...restoreCurrent,
						},
					});
				}
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
				maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
			},
		);
	} catch (error) {
		// P2025: a guarded row moved. P2034/P2028: a concurrent writer aborted the
		// serializable transaction. Nothing committed either way.
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			(error.code === 'P2025' || error.code === 'P2034' || error.code === 'P2028')
		) {
			throw createHttpError(409, 'The reservation or a request on it changed concurrently; reload and retry');
		}
		throw error;
	}
	logger.warn('[HydraReconcile] admin re-applied a released L2 reservation whose body confirmed', {
		hydraHeadId: head.id,
		transactionId: row.id,
		intendedTxHash: row.intendedTxHash,
		releasedBy: stalled.releasedBy,
		actorApiKeyId,
	});
	return {
		transactionId: row.id,
		purchaseRequestIds: stalled.purchaseRequestIds,
		paymentRequestIds: stalled.paymentRequestIds,
	};
}
