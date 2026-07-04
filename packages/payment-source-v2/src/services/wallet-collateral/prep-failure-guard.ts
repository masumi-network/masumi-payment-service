import { prisma } from '@masumi/payment-core/db';

/**
 * A collateral-prep failure classified `prep_tx_failed` is TRANSIENT (Blockfrost
 * 5xx/timeout, a DB serialization blip, or a spent-UTxO race) and normally clears
 * on the next scheduler tick — so the caller leaves the request queued. But a
 * DETERMINISTIC prep failure (a build/mesh bug, or a wallet whose UTxO set the
 * prep tx can never satisfy) would otherwise retry every tick forever with no
 * operator-visible *Failed row. Bound it: count consecutive prep_tx_failed
 * attempts per request and surface as *Failed once this threshold is reached.
 *
 * The counter is reset to 0 whenever collateral prep succeeds (the `ready`
 * gate), so this bounds *consecutive* failures: a transient failure that is
 * eventually followed by a successful prep does not accumulate toward the cap.
 * A wallet that fails ~MAX ticks in a row without ever reaching `ready` is
 * treated as genuinely stuck and surfaced as *Failed (which is re-queueable).
 */
export const MAX_COLLATERAL_PREP_FAILURES = 10;

/**
 * Pure decision — unit-testable without a DB. `newCount` is the post-increment
 * value (i.e. counting the attempt that just failed).
 */
export function prepFailureThresholdReached(newCount: number): boolean {
	return newCount >= MAX_COLLATERAL_PREP_FAILURES;
}

/**
 * Increment a RegistryRequest's collateral-prep failure counter and report
 * whether the threshold is now reached (caller then marks the request *Failed).
 */
export async function recordRegistryPrepFailure(requestId: string): Promise<boolean> {
	const updated = await prisma.registryRequest.update({
		where: { id: requestId },
		data: { collateralPrepFailureCount: { increment: 1 } },
		select: { collateralPrepFailureCount: true },
	});
	return prepFailureThresholdReached(updated.collateralPrepFailureCount);
}

/** Same contract as {@link recordRegistryPrepFailure} for the inbox model. */
export async function recordInboxPrepFailure(requestId: string): Promise<boolean> {
	const updated = await prisma.inboxAgentRegistrationRequest.update({
		where: { id: requestId },
		data: { collateralPrepFailureCount: { increment: 1 } },
		select: { collateralPrepFailureCount: true },
	});
	return prepFailureThresholdReached(updated.collateralPrepFailureCount);
}

/**
 * Reset a RegistryRequest's counter once collateral prep succeeds. Conditional
 * `updateMany` (gt: 0) issues no write on the healthy path (counter already 0)
 * and needs no field loaded on the in-memory request object.
 */
export async function resetRegistryPrepFailureCount(requestId: string): Promise<void> {
	await prisma.registryRequest.updateMany({
		where: { id: requestId, collateralPrepFailureCount: { gt: 0 } },
		data: { collateralPrepFailureCount: 0 },
	});
}

/** Same contract as {@link resetRegistryPrepFailureCount} for the inbox model. */
export async function resetInboxPrepFailureCount(requestId: string): Promise<void> {
	await prisma.inboxAgentRegistrationRequest.updateMany({
		where: { id: requestId, collateralPrepFailureCount: { gt: 0 } },
		data: { collateralPrepFailureCount: 0 },
	});
}
