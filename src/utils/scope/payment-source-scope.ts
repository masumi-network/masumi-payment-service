import createHttpError from 'http-errors';

/**
 * Returns the id filter fragment for a Prisma PaymentSource where clause.
 * Returns undefined when paymentSourceIds is null (unscoped = access all).
 * Safe to spread directly: { ...getPaymentSourceIdFilter(ctx.paymentSourceIds) }
 */
export function getPaymentSourceIdFilter(paymentSourceIds: string[] | null): { id: { in: string[] } } | undefined {
	if (paymentSourceIds === null) return undefined;
	return { id: { in: paymentSourceIds } };
}

/**
 * For write operations: throws 403 if paymentSourceId is not in the key's scope.
 * No-op for unscoped keys (null paymentSourceIds = access all).
 */
export function assertPaymentSourceInScope(paymentSourceId: string, paymentSourceIds: string[] | null): void {
	if (paymentSourceIds === null) return;
	if (!paymentSourceIds.includes(paymentSourceId)) {
		throw createHttpError(403, 'Forbidden: payment source not in API key scope');
	}
}
