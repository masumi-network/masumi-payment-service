import { Prisma, X402PaymentDirection, X402PaymentStatus } from '@masumi/payment-core/db';
import { SETTLE_STALE_MS } from './settle-lock';

export type X402AttemptFilterInput = {
	status?: X402PaymentStatus;
	direction?: X402PaymentDirection;
	caip2Network?: string;
	filterNeedsManualAction?: boolean;
};

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
		// `Verified` is also the terminal state of every successful InboundVerify attempt, so the
		// trace-less branches pin direction to InboundSettle instead of flooding the backlog with
		// healthy verifies (the errored branch is settle-only already: verifies record errors on
		// Failed rows, never on Verified ones).
		const stuckBefore = new Date(Date.now() - SETTLE_STALE_MS);
		return {
			...networkFilter,
			direction: input.direction,
			OR: [
				{ status: X402PaymentStatus.Verified, errorReason: { not: null } },
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
		status: input.status,
		direction: input.direction,
	};
}
