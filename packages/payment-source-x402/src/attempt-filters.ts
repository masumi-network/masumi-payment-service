import { Prisma, X402PaymentDirection, X402PaymentStatus } from '@masumi/payment-core/db';
import { SETTLE_STALE_MS } from './settle-lock';

export type X402AttemptFilterInput = {
	status?: X402PaymentStatus;
	direction?: X402PaymentDirection;
	// Coarse buy/sell filter for the "Pay" (outbound) vs "Receive" (both inbound directions)
	// views. A specific `direction` takes precedence when both are supplied.
	side?: 'buy' | 'sell';
	caip2Network?: string;
	filterNeedsManualAction?: boolean;
	// Tenant scope: when set, restricts to attempts initiated by this API key (undefined = all,
	// for an admin/operator). This is how a downgraded pay key sees only its own node history.
	apiKeyId?: string;
};

// Resolve the direction filter: an explicit direction wins; otherwise a side maps to its group
// (buy → the single outbound direction, sell → both inbound directions).
function resolveDirectionFilter(input: X402AttemptFilterInput): Prisma.X402PaymentAttemptWhereInput['direction'] {
	if (input.direction != null) return input.direction;
	if (input.side === 'buy') return X402PaymentDirection.OutboundPayment;
	if (input.side === 'sell') {
		return { in: [X402PaymentDirection.InboundVerify, X402PaymentDirection.InboundSettle] };
	}
	return undefined;
}

/**
 * Where-fragment shared by listX402PaymentAttempts and
 * countX402PaymentAttempts.
 *
 * `filterNeedsManualAction` selects the settle-reconciliation backlog —
 * the states reconcileX402PaymentAttempt accepts:
 *   - `Verified` with a recorded error (settle threw, or the facilitator
 *     reported failure) — intentionally never auto-failed; see service.ts.
 *   - a stale trace-less `Verified` InboundSettle marker (settle was
 *     interrupted before anything could be recorded).
 *   - a stale `Settled` InboundSettle missing its settlement row (settle
 *     succeeded but persisting the settlement failed).
 * Staleness (SETTLE_STALE_MS) keeps live in-flight settles out of the
 * backlog. Those rows need an operator to check the chain before retrying
 * or refunding, so this filter overrides an explicit status filter.
 */
export function buildX402AttemptWhere(input: X402AttemptFilterInput): Prisma.X402PaymentAttemptWhereInput {
	// Network is filtered through the rail relation now that the attempt has no caip2Network column.
	const networkFilter: Prisma.X402PaymentAttemptWhereInput =
		input.caip2Network != null ? { Network: { caip2Id: input.caip2Network } } : {};
	if (input.filterNeedsManualAction === true) {
		// `Verified` is also the terminal state of every successful InboundVerify attempt, so every
		// branch pins direction to InboundSettle instead of flooding the backlog with healthy
		// verifies. The errored branch needs the pin too: reconcile only accepts InboundSettle, so
		// a Verified verify row carrying an errorReason (e.g. a remote facilitator returning
		// isValid with an invalidReason) would otherwise be an unclearable backlog entry.
		const stuckBefore = new Date(Date.now() - SETTLE_STALE_MS);
		return {
			...networkFilter,
			apiKeyId: input.apiKeyId,
			direction: resolveDirectionFilter(input),
			OR: [
				{
					direction: X402PaymentDirection.InboundSettle,
					status: X402PaymentStatus.Verified,
					errorReason: { not: null },
				},
				{
					direction: X402PaymentDirection.InboundSettle,
					status: X402PaymentStatus.Verified,
					updatedAt: { lt: stuckBefore },
				},
				{
					direction: X402PaymentDirection.InboundSettle,
					status: X402PaymentStatus.Settled,
					Settlement: { is: null },
					updatedAt: { lt: stuckBefore },
				},
			],
		};
	}
	return {
		...networkFilter,
		apiKeyId: input.apiKeyId,
		status: input.status,
		direction: resolveDirectionFilter(input),
	};
}
