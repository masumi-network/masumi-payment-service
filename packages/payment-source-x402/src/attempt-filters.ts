import { X402PaymentDirection, X402PaymentStatus } from '@masumi/payment-core/db';

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
 * `filterNeedsManualAction` selects the settle-reconciliation backlog: rows
 * the settle path intentionally left `Verified` with a recorded error
 * (settle threw, or the facilitator reported failure) instead of
 * auto-failing — see the settle handling in service.ts. Those rows need an
 * operator to check the chain before retrying or refunding, so this filter
 * overrides an explicit status filter.
 */
export function buildX402AttemptWhere(input: X402AttemptFilterInput) {
	if (input.filterNeedsManualAction === true) {
		return {
			direction: input.direction,
			caip2Network: input.caip2Network,
			status: X402PaymentStatus.Verified,
			errorReason: { not: null },
		};
	}
	return {
		status: input.status,
		direction: input.direction,
		caip2Network: input.caip2Network,
	};
}
