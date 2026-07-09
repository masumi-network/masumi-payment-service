import createHttpError from 'http-errors';
import { X402PaymentDirection, X402PaymentStatus, prisma } from '@masumi/payment-core/db';

// Manually resolve an inbound settle that the settle flow intentionally left `Verified` with a
// recorded error (settle threw, or the facilitator reported failure) — the "needs manual action"
// backlog surfaced by listX402PaymentAttempts({ filterNeedsManualAction }). Settling x402 is a
// single-use on-chain authorization, so the service never auto-decides this: an operator confirms
// on-chain whether funds moved and declares the outcome here.
//   - 'failed'  : funds did NOT move (nonce not consumed) → mark Failed; a fresh settle may retry.
//   - 'settled' : funds moved → record the settlement the crashed flow lost (txHash required).
export async function reconcileX402PaymentAttempt(input: {
	attemptId: string;
	resolution: 'settled' | 'failed';
	txHash?: string;
}) {
	const attempt = await prisma.x402PaymentAttempt.findUnique({
		where: { id: input.attemptId },
		select: { id: true, direction: true, status: true, errorReason: true, paymentPayloadHash: true },
	});
	if (attempt == null) {
		throw createHttpError(404, 'x402 payment attempt not found');
	}
	// Only the settle-reconciliation backlog is reconcilable; anything else is already resolved or
	// was never in the ambiguous state, so reject rather than silently mutating an unrelated row.
	if (
		attempt.direction !== X402PaymentDirection.InboundSettle ||
		attempt.status !== X402PaymentStatus.Verified ||
		attempt.errorReason == null
	) {
		throw createHttpError(409, 'x402 payment attempt is not awaiting reconciliation');
	}

	if (input.resolution === 'failed') {
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
	// reconcile (or racing a late settle) will not create a duplicate settlement.
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
