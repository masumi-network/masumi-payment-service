/**
 * Rotating a stuck request out of the head of its wallet's L2 queue.
 *
 * The six L2 escrow passes select one request per wallet, oldest first, because
 * a wallet can hold only one durable L2 reservation at a time. That makes the
 * oldest eligible request a head-of-line: as long as it stays eligible, it is
 * chosen on every tick, and everything behind it waits.
 *
 * Which is fine when a failure is transient — the next tick is a retry. It is
 * not fine when a request cannot progress at all: a payment carrying an
 * unresolved terminal hash defers on every single tick, forever, and every
 * other escrow on that wallet waits behind it while its own deadlines pass.
 *
 * The cooldown the selection already honours is what breaks the cycle. Pushing
 * it forward skips this request for a minute and lets the queue behind it move;
 * nothing else changes, and the request stays exactly as retryable as it was.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

/**
 * How long a deferred request stands aside.
 *
 * Long enough that a wallet with several waiting escrows gets through them,
 * short enough that a request deferring on a genuinely transient condition —
 * a head still catching up, a UTxO not yet observed — is retried well inside
 * any escrow deadline.
 */
export const L2_DEFERRAL_COOLDOWN_MS = 60_000;

/**
 * Stand a payment request down for one cooldown.
 *
 * Failure is logged and swallowed: this runs inside a catch arm whose job is to
 * unlock the wallet, and a throw here would skip that.
 */
export async function rotateDeferredL2PaymentRequest(requestId: string): Promise<void> {
	try {
		await prisma.paymentRequest.update({
			where: { id: requestId },
			data: { sellerCoolDownTime: BigInt(Date.now() + L2_DEFERRAL_COOLDOWN_MS) },
		});
	} catch (error) {
		logger.warn('Could not apply the L2 deferral cooldown to a payment request', {
			requestId,
			error: (error as Error).message,
		});
	}
}

/** The buyer-side twin. */
export async function rotateDeferredL2PurchaseRequest(requestId: string): Promise<void> {
	try {
		await prisma.purchaseRequest.update({
			where: { id: requestId },
			data: { buyerCoolDownTime: BigInt(Date.now() + L2_DEFERRAL_COOLDOWN_MS) },
		});
	} catch (error) {
		logger.warn('Could not apply the L2 deferral cooldown to a purchase request', {
			requestId,
			error: (error as Error).message,
		});
	}
}
