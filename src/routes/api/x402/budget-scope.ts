import type { X402BudgetScope } from '@masumi/payment-source-x402/networks';

/**
 * Which budgets a caller of GET /x402/budgets may see.
 *
 * GET /x402/budgets is pay-level so a key that spends from a delegated wallet can
 * read the allowance governing that spend without being made admin (which would
 * also grant it wallet create/update/delete). That only holds if the caller can
 * never widen the result set:
 *
 * - `apiKeyId` is an optional, caller-supplied query parameter, and an unscoped
 *   list returns every tenant's budgets. Honouring it for a non-admin would let
 *   any pay key read another tenant's allowances just by naming their key id.
 * - The response carries `apiKeyId` and `createdById`, so a leak here exposes key
 *   ids, not just amounts.
 *
 * So a non-admin is pinned to its own id and the requested filter is discarded
 * rather than rejected — a scoped key asking about someone else gets its own
 * budgets, never a 403 that would confirm the other key exists.
 */
export function budgetScopeFor(
	ctx: { canAdmin: boolean; id: string },
	requestedApiKeyId: string | undefined,
): X402BudgetScope {
	if (!ctx.canAdmin) {
		return { apiKeyId: ctx.id };
	}
	return requestedApiKeyId == null ? 'all' : { apiKeyId: requestedApiKeyId };
}
