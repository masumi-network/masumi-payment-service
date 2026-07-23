import { resolveTxHash } from '@meshsdk/core';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import {
	PaymentAction,
	HydraHeadStatus,
	Prisma,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { HydraTransactionRejectedError } from '@/lib/hydra/hydra/errors';
import { requireHydraValidityUpperSlot } from '@/services/hydra-connection-manager/hydra-transaction-evidence';
import { connectPreviousAction, createNextPaymentAction, createNextPurchaseAction } from '@/services/shared';

export type ReservedL2SubmissionOutcome =
	| { status: 'accepted'; intendedTxHash: string; txHash: string }
	| { status: 'accepted-db-pending'; intendedTxHash: string; txHash: string; error: unknown }
	| {
			status: 'ambiguous';
			phase: 'submit' | 'hash-mismatch' | 'rollback';
			intendedTxHash: string;
			error: unknown;
			rejectionError?: HydraTransactionRejectedError;
	  }
	| { status: 'definitively-rejected'; intendedTxHash: string; error: HydraTransactionRejectedError };

/**
 * Serialize L2 reservations with head finalization and reject stale providers.
 *
 * The row lock closes the race where a scheduler built against an Open head,
 * the head reached Final, and the scheduler then persisted a new reservation
 * immediately before the reconciler disconnected its evidence sockets.
 */
export async function lockOpenHydraHeadForL2Reservation(
	tx: Prisma.TransactionClient,
	hydraHeadId: string,
): Promise<void> {
	const heads = await tx.$queryRaw<
		Array<{ status: HydraHeadStatus; isEnabled: boolean; isClosing: boolean; initTxHash: string | null }>
	>(
		Prisma.sql`
			SELECT "status", "isEnabled", "isClosing", "initTxHash"
			FROM "HydraHead"
			WHERE "id" = ${hydraHeadId}
			FOR UPDATE
		`,
	);
	const head = heads[0];
	if (
		head == null ||
		!head.isEnabled ||
		head.isClosing ||
		head.initTxHash == null ||
		head.status !== HydraHeadStatus.Open
	) {
		throw new Error(`Hydra head ${hydraHeadId} is no longer accepting L2 reservations`);
	}
}

type ReservedL2SubmissionCallbacks<TReservation> = {
	signedTx: string;
	reserve: (intendedTxHash: string, invalidHereafterSlot: bigint) => Promise<TReservation>;
	submit: (signedTx: string) => Promise<string>;
	finalize: (reservation: TReservation, txHash: string, intendedTxHash: string) => Promise<void>;
	rollback: (reservation: TReservation, intendedTxHash: string) => Promise<void>;
	resolveIntendedTxHash?: (signedTx: string) => string;
	resolveValidityUpperSlot?: (signedTx: string) => bigint;
};

/**
 * Submit an L2 transaction without ever losing ownership of an ambiguous body.
 *
 * The durable reservation always precedes NewTx. Only hydra-node's explicit,
 * transaction-specific rejection permits rollback; every transport/protocol or
 * post-accept database failure leaves the reservation Pending for confirmed-CBOR
 * reconciliation.
 */
export async function executeReservedL2Submission<TReservation>(
	callbacks: ReservedL2SubmissionCallbacks<TReservation>,
): Promise<ReservedL2SubmissionOutcome> {
	const intendedTxHash = (callbacks.resolveIntendedTxHash ?? ((tx) => String(resolveTxHash(tx))))(callbacks.signedTx);
	const invalidHereafterSlot = (callbacks.resolveValidityUpperSlot ?? requireHydraValidityUpperSlot)(
		callbacks.signedTx,
	);
	if (invalidHereafterSlot < 0n) throw new Error('L2 submission invalid_hereafter slot must be non-negative');
	const reservation = await callbacks.reserve(intendedTxHash, invalidHereafterSlot);

	let txHash: string;
	try {
		txHash = await callbacks.submit(callbacks.signedTx);
	} catch (error) {
		if (error instanceof HydraTransactionRejectedError) {
			try {
				await callbacks.rollback(reservation, intendedTxHash);
				return { status: 'definitively-rejected', intendedTxHash, error };
			} catch (rollbackError) {
				return {
					status: 'ambiguous',
					phase: 'rollback',
					intendedTxHash,
					error: rollbackError,
					rejectionError: error,
				};
			}
		}

		return { status: 'ambiguous', phase: 'submit', intendedTxHash, error };
	}

	if (txHash !== intendedTxHash) {
		return {
			status: 'ambiguous',
			phase: 'hash-mismatch',
			intendedTxHash,
			error: new Error(`Hydra returned divergent txHash ${txHash} vs intended ${intendedTxHash}`),
		};
	}

	try {
		await callbacks.finalize(reservation, txHash, intendedTxHash);
	} catch (error) {
		return { status: 'accepted-db-pending', intendedTxHash, txHash, error };
	}

	return { status: 'accepted', intendedTxHash, txHash };
}

type L2ActionData = {
	resultHash?: string | null;
	submittedTxHash?: string | null;
};

type CommonL2ActionSubmission = {
	operation: string;
	requestId: string;
	nextActionId: string;
	previousTransactionId: string;
	walletId: string;
	walletLockedAt: Date;
	hydraHeadId: string;
	signedTx: string;
	submitTx: (signedTx: string) => Promise<string>;
};

type PaymentL2ActionSubmission = CommonL2ActionSubmission & {
	requestKind: 'payment';
	initiatedAction: PaymentAction;
	retryAction: PaymentAction;
	initiatedActionData?: L2ActionData;
	retryActionData?: L2ActionData;
};

type PurchaseL2ActionSubmission = CommonL2ActionSubmission & {
	requestKind: 'purchase';
	initiatedAction: PurchasingAction;
	retryAction: PurchasingAction;
	initiatedActionData?: L2ActionData;
	retryActionData?: L2ActionData;
};

export type SubmitReservedL2ActionParams = PaymentL2ActionSubmission | PurchaseL2ActionSubmission;

type L2ActionReservation = {
	transactionId: string;
	initiatedActionId: string;
	intendedTxHash: string;
};

/**
 * Upgrade the exact scheduler lease returned by lockAndQueryX into a durable
 * pending-transaction reservation.
 *
 * Matching the timestamp is an ABA guard: after T1 expires, a reaper may clear
 * it and another worker may acquire T2 while the original worker is still
 * building. The T1 worker must not be allowed to claim that fresh T2 lease.
 */
async function claimL2WalletLease(
	tx: Prisma.TransactionClient,
	params: {
		walletId: string;
		walletLockedAt: Date;
		transactionId: string;
		operation: string;
	},
): Promise<void> {
	const claimedWallet = await tx.hotWallet.updateMany({
		where: {
			id: params.walletId,
			deletedAt: null,
			lockedAt: params.walletLockedAt,
			pendingTransactionId: null,
		},
		data: { pendingTransactionId: params.transactionId, lockedAt: new Date() },
	});
	if (claimedWallet.count !== 1) {
		throw new Error(`L2 wallet ${params.walletId} was not exclusively available for ${params.operation}`);
	}
}

/** Shared reservation-first implementation for all six non-locking V2 L2 actions. */
export async function submitReservedL2Action(
	params: SubmitReservedL2ActionParams,
): Promise<ReservedL2SubmissionOutcome> {
	if (!(params.walletLockedAt instanceof Date) || !Number.isFinite(params.walletLockedAt.getTime())) {
		throw new Error(`L2 wallet ${params.walletId} has no valid scheduler lease for ${params.operation}`);
	}
	const outcome = await executeReservedL2Submission<L2ActionReservation>({
		signedTx: params.signedTx,
		reserve: async (intendedTxHash, invalidHereafterSlot) =>
			await reserveL2Action(params, intendedTxHash, invalidHereafterSlot),
		submit: params.submitTx,
		finalize: async (reservation, txHash, intendedTxHash) =>
			await finalizeL2Action(params, reservation, txHash, intendedTxHash),
		rollback: async (reservation, intendedTxHash) => await rollbackL2Action(params, reservation, intendedTxHash),
	});

	const context = {
		operation: params.operation,
		requestId: params.requestId,
		walletId: params.walletId,
		hydraHeadId: params.hydraHeadId,
		intendedTxHash: outcome.intendedTxHash,
	};
	if (outcome.status === 'accepted') {
		logger.info('L2 action submitted to head', { ...context, txHash: outcome.txHash });
	} else if (outcome.status === 'definitively-rejected') {
		logger.warn('L2 action explicitly rejected; matching reservation rolled back', {
			...context,
			error: outcome.error,
		});
	} else if (outcome.status === 'accepted-db-pending') {
		logger.error('L2 action accepted but final txHash persistence failed; reservation retained', {
			...context,
			txHash: outcome.txHash,
			error: outcome.error,
		});
	} else {
		logger.error('L2 action submit outcome is ambiguous; reservation retained', {
			...context,
			phase: outcome.phase,
			error: outcome.error,
		});
	}

	return outcome;
}

async function reserveL2Action(
	params: SubmitReservedL2ActionParams,
	intendedTxHash: string,
	invalidHereafterSlot: bigint,
): Promise<L2ActionReservation> {
	return await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (tx) => {
					await lockOpenHydraHeadForL2Reservation(tx, params.hydraHeadId);
					const transaction = await tx.transaction.create({
						data: {
							intendedTxHash,
							invalidHereafterSlot,
							status: TransactionStatus.Pending,
							layer: TransactionLayer.L2,
							l2ReservationPreviousActionId: params.nextActionId,
							l2ReservationPreviousTransactionId: params.previousTransactionId,
							l2ReservationPreviousLayer: TransactionLayer.L2,
							lastCheckedAt: new Date(),
							HydraHead: { connect: { id: params.hydraHeadId } },
						},
						select: { id: true },
					});

					await claimL2WalletLease(tx, {
						walletId: params.walletId,
						walletLockedAt: params.walletLockedAt,
						transactionId: transaction.id,
						operation: params.operation,
					});

					const updatedRequest =
						params.requestKind === 'payment'
							? await tx.paymentRequest.update({
									where: {
										id: params.requestId,
										nextActionId: params.nextActionId,
										currentTransactionId: params.previousTransactionId,
										layer: TransactionLayer.L2,
									},
									data: {
										...connectPreviousAction(params.nextActionId),
										...createNextPaymentAction(params.initiatedAction, params.initiatedActionData),
										TransactionHistory: { connect: { id: params.previousTransactionId } },
										CurrentTransaction: { connect: { id: transaction.id } },
									},
									select: { nextActionId: true },
								})
							: await tx.purchaseRequest.update({
									where: {
										id: params.requestId,
										nextActionId: params.nextActionId,
										currentTransactionId: params.previousTransactionId,
										layer: TransactionLayer.L2,
									},
									data: {
										...connectPreviousAction(params.nextActionId),
										...createNextPurchaseAction(params.initiatedAction, params.initiatedActionData),
										TransactionHistory: { connect: { id: params.previousTransactionId } },
										CurrentTransaction: { connect: { id: transaction.id } },
									},
									select: { nextActionId: true },
								});

					return {
						transactionId: transaction.id,
						initiatedActionId: updatedRequest.nextActionId,
						intendedTxHash,
					};
				},
				{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000, maxWait: 30_000 },
			),
		{ label: `${params.operation}-l2-reserve` },
	);
}

async function finalizeL2Action(
	params: SubmitReservedL2ActionParams,
	reservation: L2ActionReservation,
	txHash: string,
	intendedTxHash: string,
): Promise<void> {
	await retryOnSerializationConflict(
		() =>
			prisma.transaction.update({
				where: {
					id: reservation.transactionId,
					status: TransactionStatus.Pending,
					intendedTxHash,
					txHash: null,
				},
				data: { txHash, lastCheckedAt: new Date() },
			}),
		{ label: `${params.operation}-l2-finalize` },
	);
}

async function rollbackL2Action(
	params: SubmitReservedL2ActionParams,
	reservation: L2ActionReservation,
	intendedTxHash: string,
): Promise<void> {
	await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (tx) => {
					await tx.transaction.update({
						where: {
							id: reservation.transactionId,
							status: TransactionStatus.Pending,
							intendedTxHash,
							txHash: null,
						},
						data: { status: TransactionStatus.RolledBack },
					});

					if (params.requestKind === 'payment') {
						await tx.paymentRequest.update({
							where: {
								id: params.requestId,
								nextActionId: reservation.initiatedActionId,
								currentTransactionId: reservation.transactionId,
								layer: TransactionLayer.L2,
							},
							data: {
								...connectPreviousAction(reservation.initiatedActionId),
								...createNextPaymentAction(params.retryAction, params.retryActionData),
								CurrentTransaction: { connect: { id: params.previousTransactionId } },
								TransactionHistory: {
									disconnect: { id: params.previousTransactionId },
									connect: { id: reservation.transactionId },
								},
							},
						});
					} else {
						await tx.purchaseRequest.update({
							where: {
								id: params.requestId,
								nextActionId: reservation.initiatedActionId,
								currentTransactionId: reservation.transactionId,
								layer: TransactionLayer.L2,
							},
							data: {
								...connectPreviousAction(reservation.initiatedActionId),
								...createNextPurchaseAction(params.retryAction, params.retryActionData),
								CurrentTransaction: { connect: { id: params.previousTransactionId } },
								TransactionHistory: {
									disconnect: { id: params.previousTransactionId },
									connect: { id: reservation.transactionId },
								},
							},
						});
					}

					const releasedWallet = await tx.hotWallet.updateMany({
						where: {
							id: params.walletId,
							deletedAt: null,
							pendingTransactionId: reservation.transactionId,
						},
						data: { pendingTransactionId: null, lockedAt: null },
					});
					if (releasedWallet.count !== 1) {
						throw new Error(`L2 wallet ${params.walletId} no longer owns reservation ${reservation.transactionId}`);
					}
				},
				{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000, maxWait: 30_000 },
			),
		{ label: `${params.operation}-l2-rollback` },
	);
}
