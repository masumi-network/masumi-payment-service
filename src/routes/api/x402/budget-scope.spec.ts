import { describe, expect, it } from '@jest/globals';
import { budgetScopeFor } from './budget-scope';

const SELF = 'key_self';
const OTHER = 'key_other';

describe('budgetScopeFor', () => {
	describe('non-admin (pay) caller', () => {
		const payKey = { canAdmin: false, id: SELF };

		it('is pinned to its own budgets when it asks for none in particular', () => {
			// The dashboard calls GET /x402/budgets with no query at all. Before this
			// endpoint was pay-level that meant "every budget on the node"; for a
			// non-admin it must mean "mine".
			expect(budgetScopeFor(payKey, undefined)).toEqual({ apiKeyId: SELF });
		});

		it('ignores a foreign apiKeyId instead of honouring it', () => {
			// The whole reason this endpoint can be pay-level. Honouring the filter
			// would let any pay key read another tenant's allowances, and the response
			// carries apiKeyId/createdById so it would leak key ids too.
			expect(budgetScopeFor(payKey, OTHER)).toEqual({ apiKeyId: SELF });
		});

		it('cannot reach the unrestricted list by any input', () => {
			for (const requested of [undefined, '', OTHER, SELF]) {
				expect(budgetScopeFor(payKey, requested)).not.toBe('all');
			}
		});

		it('discards rather than rejects, so it cannot probe for other keys', () => {
			// Returning its own budgets (not a 403) keeps "that key exists" and "that
			// key does not exist" indistinguishable.
			expect(budgetScopeFor(payKey, 'key_that_does_not_exist')).toEqual({ apiKeyId: SELF });
		});

		it('passing its own id is the same as passing nothing', () => {
			expect(budgetScopeFor(payKey, SELF)).toEqual(budgetScopeFor(payKey, undefined));
		});
	});

	describe('admin caller', () => {
		const adminKey = { canAdmin: true, id: SELF };

		it('sees every budget when no filter is given', () => {
			expect(budgetScopeFor(adminKey, undefined)).toBe('all');
		});

		it('may filter to another key', () => {
			expect(budgetScopeFor(adminKey, OTHER)).toEqual({ apiKeyId: OTHER });
		});
	});
});
