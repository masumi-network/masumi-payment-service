import createHttpError from 'http-errors';
import { X402PaymentDirection, X402PaymentStatus, prisma } from '@masumi/payment-core/db';
import { SETTLE_STALE_MS } from './settle-lock';

// Manually resolve an inbound settle whose outcome the service does not know — the "needs manual
// action" backlog surfaced by listX402PaymentAttempts({ filterNeedsManualAction }). Settling x402
// is a single-use on-chain authorization, so the service never auto-decides this: an operator
// confirms on-chain whether funds moved and declares the outcome here.
//   - 'failed'  : funds did NOT move (nonce not consumed) → mark Failed; a fresh settle may retry.
//   - 'settled' : funds moved → record the settlement the crashed flow lost (txHash required).
//
// Reconcilable states (all InboundSettle):
//   - Verified with a recorded errorReason: settle threw, or the facilitator reported failure
//     after the on-chain call.
//   - Verified with NO errorReason, once older than SETTLE_STALE_MS: the settle was interrupted
//     with no trace (process died mid-settle, or recording the outcome onto the marker failed).
//     A fresh trace-less marker may still be a live in-flight settle, so age alone gates it — no
//     legitimate settle can outlive the stale bound (the settle lock steals the wallet lock on
//     the same basis).
//   - Settled but MISSING its settlement row, once stale: the facilitator reported success but
//     persisting the settlement failed, so buyer replays 409 instead of short-circuiting. Funds
//     moved, so only 'settled' is accepted here — reconciling records the lost settlement row.
export async function reconcileX402PaymentAttempt(input: {
	attemptId: string;
	resolution: 'settled' | 'failed';
	txHash?: string;
}) {
	const attempt = await prisma.x402PaymentAttempt.findUnique({
		where: { id: input.attemptId },
		select: {
			id: true,
			direction: true,
			status: true,
			errorReason: true,
			paymentPayloadHash: true,
			updatedAt: true,
			Settlement: { select: { id: true } },
		},
	});
	if (attempt == null) {
		throw createHttpError(404, 'x402 payment attempt not found');
	}
	// Only the settle-reconciliation backlog is reconcilable; anything else is already resolved or
	// was never in the ambiguous state, so reject rather than silently mutating an unrelated row.
	const isStale = attempt.updatedAt.getTime() < Date.now() - SETTLE_STALE_MS;
	const isAmbiguousVerified = attempt.status === X402PaymentStatus.Verified && (attempt.errorReason != null || isStale);
	const isSettledMissingRecord = attempt.status === X402PaymentStatus.Settled && attempt.Settlement == null && isStale;
	if (attempt.direction !== X402PaymentDirection.InboundSettle || (!isAmbiguousVerified && !isSettledMissingRecord)) {
		throw createHttpError(409, 'x402 payment attempt is not awaiting reconciliation');
	}

	if (input.resolution === 'failed') {
		// A Settled attempt means the facilitator already reported success — funds moved and the
		// nonce is consumed, so a retry can never be valid; only the settlement record is missing.
		if (isSettledMissingRecord) {
			throw createHttpError(409, 'x402 payment attempt already settled on-chain; reconcile it as settled');
		}
		// The crash-window guard does NOT block Failed, so a genuine retry can proceed.
		await prisma.x402PaymentAttempt.update({
			where: { id: attempt.id },
			data: { status: X402PaymentStatus.Failed },
		});
		return { attemptId: attempt.id, status: X402PaymentStatus.Failed };
	}

	if (input.txHash == null || input.txHash === '') {
		throw createHttpError(400, 'txHash is required to reconcile an attempt as settled');
	}
	if (attempt.paymentPayloadHash == null) {
		throw createHttpError(400, 'x402 payment attempt has no payment payload hash to settle against');
	}

	// paymentPayloadHash is unique on X402Settlement, so the upsert is idempotent: re-running the
	// reconcile (or racing a late settle) will not create a duplicate settlement. For the
	// Settled-missing-record state the status update is a no-op and only the settlement row lands.
	await prisma.$transaction([
		prisma.x402Settlement.upsert({
			where: { paymentPayloadHash: attempt.paymentPayloadHash },
			create: {
				paymentAttemptId: attempt.id,
				paymentPayloadHash: attempt.paymentPayloadHash,
				success: true,
				txHash: input.txHash,
			},
			update: {},
		}),
		prisma.x402PaymentAttempt.update({
			where: { id: attempt.id },
			data: { status: X402PaymentStatus.Settled },
		}),
	]);
	return { attemptId: attempt.id, status: X402PaymentStatus.Settled };
}
