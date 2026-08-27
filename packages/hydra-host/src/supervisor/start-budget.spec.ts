/**
 * A node that is up is not spending its crash budget.
 *
 * `Unsynced` was withheld from the refund, and a drift restart is itself a
 * spawn — so a follower whose steady-state drift sits at the guard, which is
 * the ordinary state of a Blockfrost-backed node, spent one attempt per drift
 * restart and never earned one back. Four restarts across an hour of uptime
 * exhausted the budget, and the next ordinary crash was recorded `Failed` with
 * "failed to stay up after 5 attempts" about a node that had been serving all
 * along.
 */

import { describe, expect, it } from '@jest/globals';
import { earnsStartBudgetRefund } from './start-budget.js';

describe('earnsStartBudgetRefund', () => {
	it('refunds a node that answers, whatever its drift verdict', () => {
		expect(earnsStartBudgetRefund({ responsive: true })).toBe(true);
	});

	it('refunds nothing to a node that is not answering', () => {
		expect(earnsStartBudgetRefund({ responsive: false })).toBe(false);
	});
});
