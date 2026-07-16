import createHttpError from 'http-errors';
import { Prisma, X402PaymentDirection, X402PaymentStatus, prisma } from '@masumi/payment-core/db';
import { isUniqueConstraintError } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import { getX402DatabaseNow, SETTLE_STALE_MS } from './settle-lock';

const RECONCILIATION_ATTEMPT_SELECT = {
	id: true,
	direction: true,
	status: true,
	errorReason: true,
	errorMessage: true,
	paymentPayloadHash: true,
	payTo: true,
	updatedAt: true,
	evmWalletId: true,
	// Extra fields feed the settlement webhook the interrupted settle never emitted.
	supportedPaymentSourceId: true,
	registryRequestId: true,
	asset: true,
	amount: true,
	Network: { select: { caip2Id: true } },
	EvmWallet: { select: { lockedAt: true } },
	CounterpartyWallet: { select: { address: true } },
	SupportedPaymentSource: { select: { payTo: true } },
	Settlement: { select: { id: true } },
} satisfies Prisma.X402PaymentAttemptSelect;

type ReconciliationAttempt = Prisma.X402PaymentAttemptGetPayload<{
	select: typeof RECONCILIATION_ATTEMPT_SELECT;
}>;

function buildReconciliationWebhook(attempt: ReconciliationAttempt, success: boolean, txHash: string | null) {
	// Existing webhook consumers require payTo to be a string. A transition row can lack both
	// the immutable snapshot and its old source relation; reconcile the state, but do not emit a
	// contract-breaking webhook for that exceptional legacy row.
	const payTo = attempt.payTo ?? attempt.SupportedPaymentSource?.payTo ?? null;
	if (payTo == null) {
		logger.warn('Skipping x402 reconciliation webhook because the legacy attempt has no payee address', {
			attemptId: attempt.id,
		});
		return null;
	}
	return {
		attemptId: attempt.id,
		paymentPayloadHash: attempt.paymentPayloadHash,
		supportedPaymentSourceId: attempt.supportedPaymentSourceId,
		registryRequestId: attempt.registryRequestId,
		caip2Network: attempt.Network.caip2Id,
		asset: attempt.asset,
		amount: attempt.amount.toString(),
		payTo,
		payer: attempt.CounterpartyWallet?.address ?? null,
		txHash,
		success,
		// A failure webhook carries the reason the settle recorded before it got stuck (e.g.
		// settle_threw), mirroring the settle path's failure webhook; a success carries none.
		errorReason: success ? null : attempt.errorReason,
		errorMessage: success ? null : attempt.errorMessage,
	};
}

// Manually resolve an inbound settle whose outcome the service does not know — the "needs manual
// action" backlog surfaced by listX402PaymentAttempts({ filterNeedsManualAction }). Settling x402
// is a single-use on-chain authorization, so the service never auto-decides this: an operator
// confirms on-chain whether funds moved and declares the outcome here.
//   - 'failed'  : funds did NOT move (nonce not consumed) → mark Failed; a fresh settle may retry.
//   - 'settled' : funds moved → record the settlement the crashed flow lost (txHash required).
//
// Reconcilable states (all InboundSettle):
//   - Verified once older than SETTLE_STALE_MS, with or without a recorded errorReason. A remote
//     timeout or thrown response is ambiguous because the facilitator may keep processing after
//     this node aborts. Healthy long-running self-hosted settles heartbeat updatedAt together with
//     their nonce lock, so only an abandoned marker crosses this boundary.
//   - Settled but MISSING its settlement row, once stale: the facilitator reported success but
//     persisting the settlement failed, so buyer replays 409 instead of short-circuiting. Funds
//     moved, so only 'settled' is accepted here — reconciling records the lost settlement row.
export async function reconcileX402PaymentAttempt(input: {
	attemptId: string;
	resolution: 'settled' | 'failed';
	txHash?: string;
}) {
	// This first read discovers the lock key only. Eligibility is deliberately checked again after
	// taking both row locks below; otherwise a heartbeat can renew a live settle between the read
	// and the outcome write.
	const attemptIdentity = await prisma.x402PaymentAttempt.findUnique({
		where: { id: input.attemptId },
		select: { id: true, evmWalletId: true },
	});
	if (attemptIdentity == null) {
		throw createHttpError(404, 'x402 payment attempt not found');
	}

	let outcome: {
		attempt: ReconciliationAttempt;
		status: X402PaymentStatus;
		settlementTxHash: string | null;
	};
	try {
		outcome = await prisma.$transaction(async (tx) => {
			// Heartbeats renew the wallet before advancing the attempt marker. Taking the same lock
			// order prevents a deadlock and makes either the heartbeat or reconciliation win cleanly.
			if (attemptIdentity.evmWalletId != null) {
				await tx.$queryRaw<Array<{ id: string }>>`
					SELECT "id" FROM "X402EvmWallet"
					WHERE "id" = ${attemptIdentity.evmWalletId}
					FOR UPDATE
				`;
			}
			await tx.$queryRaw<Array<{ id: string }>>`
				SELECT "id" FROM "X402PaymentAttempt"
				WHERE "id" = ${attemptIdentity.id}
				FOR UPDATE
			`;

			const attempt = await tx.x402PaymentAttempt.findUnique({
				where: { id: attemptIdentity.id },
				select: RECONCILIATION_ATTEMPT_SELECT,
			});
			if (attempt == null) {
				throw createHttpError(404, 'x402 payment attempt not found');
			}
			// A relation change between the discovery read and row lock means the wallet we locked is
			// not the wallet whose heartbeat governs this attempt. Abort and let the operator retry.
			if (attempt.evmWalletId !== attemptIdentity.evmWalletId) {
				throw createHttpError(409, 'x402 payment attempt wallet changed; re-check its state');
			}

			// Only the settle-reconciliation backlog is reconcilable; anything else is already
			// resolved or was never in the ambiguous state. Evaluate this while both rows are locked.
			const databaseNow = await getX402DatabaseNow(tx);
			const staleBefore = databaseNow.getTime() - SETTLE_STALE_MS;
			const hasFreshFacilitatorLock =
				attempt.EvmWallet?.lockedAt != null && attempt.EvmWallet.lockedAt.getTime() >= staleBefore;
			const isStale = attempt.updatedAt.getTime() < staleBefore && !hasFreshFacilitatorLock;
			const isAmbiguousVerified = attempt.status === X402PaymentStatus.Verified && isStale;
			const isSettledMissingRecord =
				attempt.status === X402PaymentStatus.Settled && attempt.Settlement == null && isStale;
			if (
				attempt.direction !== X402PaymentDirection.InboundSettle ||
				(!isAmbiguousVerified && !isSettledMissingRecord)
			) {
				throw createHttpError(409, 'x402 payment attempt is not awaiting reconciliation');
			}

			if (input.resolution === 'failed') {
				// A Settled attempt means the facilitator already reported success — funds moved and
				// the nonce is consumed, so a retry can never be valid.
				if (isSettledMissingRecord) {
					throw createHttpError(409, 'x402 payment attempt already settled on-chain; reconcile it as settled');
				}
				const updated = await tx.x402PaymentAttempt.updateMany({
					where: { id: attempt.id, status: X402PaymentStatus.Verified },
					data: { status: X402PaymentStatus.Failed },
				});
				if (updated.count !== 1) {
					throw createHttpError(409, 'x402 payment attempt was concurrently resolved; re-check its state');
				}
				return { attempt, status: X402PaymentStatus.Failed, settlementTxHash: null };
			}

			if (input.txHash == null || input.txHash === '') {
				throw createHttpError(400, 'txHash is required to reconcile an attempt as settled');
			}
			if (attempt.paymentPayloadHash == null) {
				throw createHttpError(400, 'x402 payment attempt has no payment payload hash to settle against');
			}

			// The unique settlement insert is also the winner claim for two concurrent settled
			// reconciliations. A conflict rolls this transaction's status update back.
			const updated = await tx.x402PaymentAttempt.updateMany({
				where: { id: attempt.id, status: { in: [X402PaymentStatus.Verified, X402PaymentStatus.Settled] } },
				data: { status: X402PaymentStatus.Settled },
			});
			if (updated.count !== 1) {
				throw createHttpError(409, 'x402 payment attempt was concurrently resolved; re-check its state');
			}
			const settlement = await tx.x402Settlement.create({
				data: {
					paymentAttemptId: attempt.id,
					paymentPayloadHash: attempt.paymentPayloadHash,
					success: true,
					txHash: input.txHash,
					// Keep the record as complete as a normally-persisted settlement; the attempt's
					// amount is what the operator-confirmed on-chain transfer settled.
					amount: attempt.amount,
				},
				select: { paymentAttemptId: true, txHash: true },
			});
			return { attempt, status: X402PaymentStatus.Settled, settlementTxHash: settlement.txHash };
		});
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			// Covers both a concurrent winner for this attempt and a settlement with this payload
			// hash owned by a different attempt. The transaction rolls the status update back.
			throw createHttpError(409, 'x402 payment payload was concurrently settled or belongs to another attempt');
		}
		throw error;
	}

	return {
		attemptId: outcome.attempt.id,
		status: outcome.status,
		webhook: buildReconciliationWebhook(
			outcome.attempt,
			outcome.status === X402PaymentStatus.Settled,
			outcome.settlementTxHash,
		),
	};
}
