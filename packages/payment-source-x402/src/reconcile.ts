import createHttpError from 'http-errors';
import { Prisma, X402PaymentDirection, X402PaymentStatus, prisma } from '@masumi/payment-core/db';
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
			errorMessage: true,
			paymentPayloadHash: true,
			payTo: true,
			updatedAt: true,
			// Extra fields feed the settlement webhook the interrupted settle never emitted.
			supportedPaymentSourceId: true,
			registryRequestId: true,
			asset: true,
			amount: true,
			Network: { select: { caip2Id: true } },
			CounterpartyWallet: { select: { address: true } },
			SupportedPaymentSource: { select: { payTo: true } },
			Settlement: { select: { id: true } },
		},
	});
	if (attempt == null) {
		throw createHttpError(404, 'x402 payment attempt not found');
	}

	// The settlement/failure webhook the interrupted settle never emitted (a stuck settle threw
	// before the route could fire it). Mirrors the settle path's webhook shape so subscribers see a
	// manually-reconciled outcome exactly as they would a normal one.
	const buildWebhook = (success: boolean, txHash: string | null) => ({
		attemptId: attempt.id,
		paymentPayloadHash: attempt.paymentPayloadHash,
		supportedPaymentSourceId: attempt.supportedPaymentSourceId,
		registryRequestId: attempt.registryRequestId,
		caip2Network: attempt.Network.caip2Id,
		asset: attempt.asset,
		amount: attempt.amount.toString(),
		// Prefer the immutable attempt snapshot; transition rows created before the snapshot column
		// was introduced may still need the live source as a nullable fallback.
		payTo: attempt.payTo ?? attempt.SupportedPaymentSource?.payTo ?? null,
		payer: attempt.CounterpartyWallet?.address ?? null,
		txHash,
		success,
		// A failure webhook carries the reason the settle recorded before it got stuck (e.g.
		// settle_threw), mirroring the settle path's failure webhook; a success carries none.
		errorReason: success ? null : attempt.errorReason,
		errorMessage: success ? null : attempt.errorMessage,
	});
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
		// Guard on the status still being Verified: the eligibility check above is a separate
		// read, so a concurrent reconcile (or a late-completing settle) may have resolved the
		// attempt in between — the loser must 409, not overwrite a Settled outcome with Failed.
		const updated = await prisma.x402PaymentAttempt.updateMany({
			where: { id: attempt.id, status: X402PaymentStatus.Verified },
			data: { status: X402PaymentStatus.Failed },
		});
		if (updated.count !== 1) {
			throw createHttpError(409, 'x402 payment attempt was concurrently resolved; re-check its state');
		}
		return { attemptId: attempt.id, status: X402PaymentStatus.Failed, webhook: buildWebhook(false, null) };
	}

	if (input.txHash == null || input.txHash === '') {
		throw createHttpError(400, 'txHash is required to reconcile an attempt as settled');
	}
	if (attempt.paymentPayloadHash == null) {
		throw createHttpError(400, 'x402 payment attempt has no payment payload hash to settle against');
	}

	// The unique settlement insert is also the winner claim for two concurrent settled
	// reconciliations. Empty-update upsert cannot serve as a claim: after the first caller changes
	// Verified → Settled, the second status update still matches Settled and would emit its own
	// possibly-conflicting tx hash while silently accepting the first caller's settlement row.
	const paymentPayloadHash = attempt.paymentPayloadHash;
	let settlement: { paymentAttemptId: string; txHash: string | null };
	try {
		settlement = await prisma.$transaction(async (tx) => {
			// Same TOCTOU guard as the failed path: only an attempt still in a reconcilable status may
			// be flipped, so a concurrent 'failed' reconcile cannot interleave and leave a Failed
			// attempt owning a success settlement. Settled stays allowed (the missing-record state).
			const updated = await tx.x402PaymentAttempt.updateMany({
				where: { id: attempt.id, status: { in: [X402PaymentStatus.Verified, X402PaymentStatus.Settled] } },
				data: { status: X402PaymentStatus.Settled },
			});
			if (updated.count !== 1) {
				throw createHttpError(409, 'x402 payment attempt was concurrently resolved; re-check its state');
			}
			return tx.x402Settlement.create({
				data: {
					paymentAttemptId: attempt.id,
					paymentPayloadHash,
					success: true,
					txHash: input.txHash,
					// Keep the record as complete as a normally-persisted settlement; the attempt's
					// amount is what the operator-confirmed on-chain transfer settled.
					amount: attempt.amount,
				},
				select: { paymentAttemptId: true, txHash: true },
			});
		});
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
			// Covers both a concurrent winner for this attempt and a settlement with this payload hash
			// owned by a different attempt. The transaction rolls the status update back in either case.
			throw createHttpError(409, 'x402 payment payload was concurrently settled or belongs to another attempt');
		}
		throw error;
	}
	return { attemptId: attempt.id, status: X402PaymentStatus.Settled, webhook: buildWebhook(true, settlement.txHash) };
}
