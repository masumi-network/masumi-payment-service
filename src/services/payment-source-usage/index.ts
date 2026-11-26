/**
 * Whether this deployment has a payment source of a given type.
 *
 * Each contract version adds about twenty scheduled jobs. A deployment that
 * only runs V2 still ran every V1 job, each reading its tables every interval
 * and finding nothing. This is the `shouldRun` gate for those jobs, in the same
 * shape as `isHydraInUse`.
 *
 * Asked rather than configured: a payment source can be added while the
 * service runs, so a "not in use" answer is cached only briefly.
 *
 * Sticky once true, and soft-deleted sources count. The jobs are what settle
 * the requests of a source that is being retired, so going quiet when the last
 * source is deleted would strand them.
 */

import { PaymentSourceType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';

/** Long enough that the check is noise next to the jobs, short enough that a new source starts its jobs while the operator is still looking at it. */
const USAGE_CACHE_MS = 30_000;

const cachedNotInUseAt = new Map<PaymentSourceType, number>();
const inUse = new Set<PaymentSourceType>();

export function resetPaymentSourceUsageCache(): void {
	cachedNotInUseAt.clear();
	inUse.clear();
}

export async function isPaymentSourceTypeInUse(paymentSourceType: PaymentSourceType): Promise<boolean> {
	if (inUse.has(paymentSourceType)) return true;
	const checkedAt = cachedNotInUseAt.get(paymentSourceType);
	// Monotonic clock: a wall-clock step back must not stretch the cached miss.
	if (checkedAt !== undefined && performance.now() - checkedAt < USAGE_CACHE_MS) return false;

	const source = await prisma.paymentSource.findFirst({ where: { paymentSourceType }, select: { id: true } });
	// A concurrent call may have seen the first source while this one waited.
	if (inUse.has(paymentSourceType)) return true;
	if (source === null) {
		cachedNotInUseAt.set(paymentSourceType, performance.now());
		return false;
	}
	inUse.add(paymentSourceType);
	cachedNotInUseAt.delete(paymentSourceType);
	return true;
}

export const isPaymentSourceV1InUse = () => isPaymentSourceTypeInUse(PaymentSourceType.Web3CardanoV1);
export const isPaymentSourceV2InUse = () => isPaymentSourceTypeInUse(PaymentSourceType.Web3CardanoV2);
