/**
 * Reserve, submit and record one signed L2 funds-lock: the money-safety half of
 * an in-head lock, shared by plain and guarded wallets. The request row and the
 * exact intended hash are written before NewTx, so an accepted lock can never be
 * retried or re-routed to L1 because a post-accept write failed.
 */
import { resolveTxHash } from '@meshsdk/core';
import { PurchasingAction, TransactionLayer, TransactionStatus, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { HydraProvider } from '@/lib/hydra';
import { HydraTransactionRejectedError } from '@/lib/hydra/hydra/errors';
import { connectPreviousAction, createNextPurchaseAction } from '@/services/shared';
import { requireHydraValidityUpperSlot } from '@/services/hydra-connection-manager/hydra-transaction-evidence';
import { lockOpenHydraHeadForL2Reservation } from '../../l2-submission';
import {
	requireFreshL2LockHeadClock,
	retainInitialL2LockAfterSubmitFailure,
	type L2LockAttemptOutcome,
} from './l2-lock-helpers';

export type PaymentSourceWithL2Relations = Prisma.PaymentSourceGetPayload<{
	include: {
		PaymentSourceConfig: true;
		PurchaseRequests: {
			include: {
				PaidFunds: true;
				SellerWallet: true;
				NextAction: true;
				HotWalletLimit: { select: { id: true } };
			};
		};
		HotWallets: {
			include: {
				Secret: true;
				GuardedWallet: true;
			};
		};
	};
}>;

export type L2PurchaseRequest = PaymentSourceWithL2Relations['PurchaseRequests'][number];
export type L2HotWallet = PaymentSourceWithL2Relations['HotWallets'][number];

export async function reserveAndSubmitL2Lock(params: {
	request: L2PurchaseRequest;
	hotWallet: L2HotWallet;
	hydraHeadId: string;
	hydraProvider: HydraProvider;
	signedTx: string;
	buyerReturnAddress: string | null;
	collateralReturnLovelace: bigint;
	/** The lock spends the hot wallet's guarded smart wallet, co-signed by the quorum. */
	guardedWallet: boolean;
	/** Milliseconds the caller spent before this point, logged with the submit timings. */
	buildTimings: Record<string, number>;
}): Promise<L2LockAttemptOutcome> {
	const { request, hotWallet, hydraHeadId, hydraProvider, signedTx, buyerReturnAddress, guardedWallet } = params;
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	const intendedTxHash = resolveTxHash(signedTx);
	const invalidHereafterSlot = requireHydraValidityUpperSlot(signedTx);
	// Build/sign can take long enough for the original Tick to become stale or
	// for the head to cross payByTime. Re-check immediately before the atomic DB
	// reservation; the signed body's upper bound handles the remaining race to
	// NewTx without permitting a post-deadline lock.
	const reservationHeadTimeMs = requireFreshL2LockHeadClock({
		headClock: hydraProvider.getHeadClock(),
		payByTime: request.payByTime,
	});

	// Reserve request + wallet BEFORE NewTx. A positive node acknowledgement
	// followed by a DB outage must leave durable evidence that this exact signed
	// body owns the request; otherwise the loop below can submit it from another head wallet and
	// the same scheduler tick can also pick it up in the L1 pass.
	const tReserve = Date.now();
	const reservation = await reserveL2LockBeforeSubmit({
		request,
		hotWallet,
		hydraHeadId,
		intendedTxHash,
		invalidHereafterSlot,
		buyerReturnAddress,
		collateralReturnLovelace: params.collateralReturnLovelace,
		guardedWallet,
		trustedHeadTimeMs: reservationHeadTimeMs,
	});

	const reserveMs = Date.now() - tReserve;

	const tSubmit = Date.now();
	let txHash: string;
	try {
		txHash = await hydraProvider.submitTx(signedTx);
	} catch (error) {
		// Neither transport failure nor TxInvalid proves that an initial lock's
		// wallet inputs remain fresh. A withholding node can relay a valid lock and
		// then report rejection; releasing this reservation would permit a second
		// lock from different inputs. Keep it fail-closed for reconciliation.
		// Record a matching rejection for diagnosis. It does not authorize release:
		// expiry cannot disprove acceptance in a snapshot withheld before expiry.
		if (error instanceof HydraTransactionRejectedError) {
			await prisma.transaction
				.updateMany({
					where: { id: reservation.transactionId, status: TransactionStatus.Pending, l2RejectedByHeadAt: null },
					data: { l2RejectedByHeadAt: new Date(), l2RejectedByHeadReason: error.message.slice(0, 500) },
				})
				.catch((persistError: unknown) => {
					// The reservation protects the funds even if its diagnostic marker
					// cannot be saved.
					logger.warn('L2 lock: could not record the head rejection on the reservation', {
						purchaseRequestId: request.id,
						hydraHeadId,
						error: persistError instanceof Error ? persistError.message : persistError,
					});
				});
		}
		return retainInitialL2LockAfterSubmitFailure(intendedTxHash, error);
	}
	const submitMs = Date.now() - tSubmit;

	// Every phase, not just the transaction. The transaction was never the
	// expensive part — build, sign and submit come to about twenty milliseconds
	// against a lock that takes a quarter of a second — and without the rest
	// measured beside them it is impossible to say where the other 90% goes.
	logger.info('L2 lock tx timing', {
		purchaseRequestId: request.id,
		hydraHeadId,
		...params.buildTimings,
		reserveMs,
		submitMs,
	});

	if (txHash !== intendedTxHash) {
		const error = new Error(`Hydra returned divergent txHash ${txHash} vs intended ${intendedTxHash}`);
		logger.error('L2 funds-lock returned divergent txHash; preserving reservation fail-closed', {
			purchaseRequestId: request.id,
			hydraHeadId,
			txHash,
			intendedTxHash,
		});
		return { status: 'ambiguous', intendedTxHash, error };
	}

	const tFinalize = Date.now();
	try {
		await finalizeAcceptedL2Lock({
			request,
			reservation,
			txHash,
		});
		logger.info('L2 lock finalize timing', {
			purchaseRequestId: request.id,
			hydraHeadId,
			finalizeMs: Date.now() - tFinalize,
		});
	} catch (error) {
		// A positive node acknowledgement is not consensus proof. The pre-submit
		// reservation remains Pending with intendedTxHash until signed snapshot
		// evidence reconciles it, keeping both this loop and L1 fail-closed.
		logger.error('L2 funds-lock accepted but txHash persistence failed; reservation retained', {
			purchaseRequestId: request.id,
			walletId: hotWallet.id,
			hydraHeadId,
			transactionId: reservation.transactionId,
			txHash,
			error,
		});
		return { status: 'accepted-db-pending', txHash, error };
	}

	logger.info('L2 funds-lock submitted to head', {
		purchaseRequestId: request.id,
		walletId: hotWallet.id,
		hydraHeadId,
		txHash,
	});
	return { status: 'accepted', txHash };
}

type L2LockReservation = {
	transactionId: string;
	initiatedActionId: string;
};

async function reserveL2LockBeforeSubmit(params: {
	request: L2PurchaseRequest;
	hotWallet: L2HotWallet;
	hydraHeadId: string;
	intendedTxHash: string;
	invalidHereafterSlot: bigint;
	buyerReturnAddress: string | null;
	collateralReturnLovelace: bigint;
	trustedHeadTimeMs: number;
	guardedWallet: boolean;
}): Promise<L2LockReservation> {
	const {
		request,
		hotWallet,
		hydraHeadId,
		intendedTxHash,
		invalidHereafterSlot,
		buyerReturnAddress,
		collateralReturnLovelace,
		trustedHeadTimeMs,
		guardedWallet,
	} = params;
	return await prisma.$transaction(
		async (tx) => {
			await lockOpenHydraHeadForL2Reservation(tx, hydraHeadId);
			const l2Transaction = await tx.transaction.create({
				data: {
					intendedTxHash,
					invalidHereafterSlot,
					status: TransactionStatus.Pending,
					layer: TransactionLayer.L2,
					l2ReservationPreviousActionId: request.nextActionId,
					l2ReservationPreviousTransactionId: request.currentTransactionId,
					l2ReservationPreviousLayer: request.layer,
					l2ReservationPreviousSmartContractWalletId: request.smartContractWalletId,
					l2ReservationPreviousBuyerReturnAddress: request.buyerReturnAddress,
					l2ReservationPreviousCollateralReturn: request.collateralReturnLovelace,
					HydraHead: { connect: { id: hydraHeadId } },
					lastCheckedAt: new Date(),
				},
				select: { id: true },
			});

			const claimedWallet = await tx.hotWallet.updateMany({
				where: {
					id: hotWallet.id,
					deletedAt: null,
					lockedAt: null,
					pendingTransactionId: null,
					// Re-checked here, not only at the pass's read: a guard attached since then must win,
					// or a plain lock would leave the hot wallet key without Exchain co-signing. A guarded
					// lock needs the guard still attached, so a detach in between cannot reuse its body.
					GuardedWallet: guardedWallet ? { isNot: null } : { is: null },
				},
				data: {
					lockedAt: new Date(),
					pendingTransactionId: l2Transaction.id,
				},
			});
			if (claimedWallet.count !== 1) {
				throw new Error(`L2 purchasing wallet ${hotWallet.id} was claimed or guarded concurrently`);
			}

			const updatedRequest = await tx.purchaseRequest.update({
				where: {
					id: request.id,
					nextActionId: request.nextActionId,
					currentTransactionId: null,
					// Bind the reservation to the exact deadline that was checked and
					// require it to remain ahead of the trusted head clock. A concurrent
					// deadline edit cannot turn a validated request into an expired lock.
					payByTime: { equals: request.payByTime, gt: BigInt(trustedHeadTimeMs) },
				},
				data: {
					layer: TransactionLayer.L2,
					...connectPreviousAction(request.nextActionId),
					...createNextPurchaseAction(PurchasingAction.FundsLockingInitiated),
					collateralReturnLovelace,
					SmartContractWallet: { connect: { id: hotWallet.id } },
					buyerReturnAddress,
					CurrentTransaction: { connect: { id: l2Transaction.id } },
				},
				select: { nextActionId: true },
			});

			return {
				transactionId: l2Transaction.id,
				initiatedActionId: updatedRequest.nextActionId,
			};
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
	);
}

async function finalizeAcceptedL2Lock(params: {
	request: L2PurchaseRequest;
	reservation: L2LockReservation;
	txHash: string;
}): Promise<void> {
	const { request, reservation, txHash } = params;
	await prisma.$transaction(async (tx) => {
		const updated = await tx.transaction.update({
			where: {
				id: reservation.transactionId,
				intendedTxHash: txHash,
				// `submitTx` now blocks on the confirmed snapshot, so the connection
				// manager's TxConfirmed listener routinely stamps this exact row
				// Confirmed before this write starts. id + intendedTxHash still pin
				// identity, so accepting Confirmed here is a no-op re-write, not a
				// loosened guard; RolledBack / FailedViaTimeout stay excluded.
				status: { in: [TransactionStatus.Pending, TransactionStatus.Confirmed] },
			},
			data: { txHash, lastCheckedAt: new Date() },
			select: { status: true },
		});

		if (updated.status === TransactionStatus.Confirmed) {
			// The confirmation listener got there first, which means it already made
			// the payment-pairing decision for this body — including a refusal to
			// pair, for its own datum-trust reasons. Finalize must not second-guess
			// that decision by running the pairing block below on a row it did not
			// write. On a Pending row (the normal case) this never triggers and the
			// block below runs exactly as before.
			//
			// The pairing the block below would have done is not dead code: the
			// listener path performs the equivalent pairing itself, in
			// `applyDatumStateToLocalRequests`
			// (`src/services/hydra-connection-manager/hydra-datum-sync.ts`) — the
			// `paymentRoutingAllowsHydra`-gated update that sets `layer: L2` and
			// connects `CurrentTransaction`.
			return;
		}

		// Pair only the SAME payment source's seller row (blockchainIdentifier is
		// globally unique, so an unscoped lookup could grab a different source's
		// payment), and mirror datum-sync's `paymentRoutingAllowsHydra` gate: a row
		// that already has on-chain state or whose seller forced L1 must NOT be
		// stamped L2 + connected to this head reservation — doing so both violates
		// the seller's routing choice and, because the connected tx then counts as
		// a head blocker whose newOnChainState can never match, permanently blocks
		// the head's final reconciliation handoff.
		const paymentRequest = await tx.paymentRequest.findUnique({
			where: {
				blockchainIdentifier: request.blockchainIdentifier,
				paymentSourceId: request.paymentSourceId,
			},
			select: { id: true, currentTransactionId: true, layer: true, onChainState: true, forceLayer: true },
		});
		if (
			paymentRequest != null &&
			paymentRequest.currentTransactionId == null &&
			paymentRequest.onChainState == null &&
			paymentRequest.forceLayer !== TransactionLayer.L1
		) {
			await tx.transaction.update({
				where: { id: reservation.transactionId, status: TransactionStatus.Pending, intendedTxHash: txHash },
				data: { l2ReservationPeerPreviousLayer: paymentRequest.layer },
			});
			await tx.paymentRequest.update({
				where: { id: paymentRequest.id, currentTransactionId: null },
				data: {
					layer: TransactionLayer.L2,
					CurrentTransaction: { connect: { id: reservation.transactionId } },
				},
			});
		}
	});
}
