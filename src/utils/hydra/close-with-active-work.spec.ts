import { describeCloseWithActiveWork } from '@/utils/hydra/close-with-active-work';

describe('describeCloseWithActiveWork', () => {
	// The old wording opened with "Cannot close", which was never true: closing
	// with live escrows is offered and always has been.
	it('does not claim the head cannot be closed', () => {
		const message = describeCloseWithActiveWork(300n, 1, 71);
		expect(message).not.toMatch(/cannot/i);
		expect(message).toMatch(/Closing now/);
	});

	it('reports both counts when both are present', () => {
		const message = describeCloseWithActiveWork(300n, 3, 71);
		expect(message).toContain('71 escrows still holding funds');
		expect(message).toContain('3 transactions still in flight');
	});

	// A head with escrows and nothing in flight should not be told about zero
	// transactions — it reads as a second, separate problem.
	it('omits a count that is zero', () => {
		const message = describeCloseWithActiveWork(300n, 0, 50);
		expect(message).toContain('50 escrows still holding funds');
		expect(message).not.toContain('transaction');
	});

	it('uses singular wording for one', () => {
		const message = describeCloseWithActiveWork(300n, 1, 1);
		expect(message).toContain('1 escrow still holding funds');
		expect(message).toContain('1 transaction still in flight');
	});

	// The wait is the whole reason to hesitate, so it has to be a duration an
	// operator can weigh rather than a number of seconds they convert.
	it('states the contestation period in readable units', () => {
		expect(describeCloseWithActiveWork(300n, 0, 1)).toContain('5 minutes');
		expect(describeCloseWithActiveWork(43_200n, 0, 1)).toContain('12 hours');
		expect(describeCloseWithActiveWork(432_000n, 0, 1)).toContain('5 days');
		expect(describeCloseWithActiveWork(45n, 0, 1)).toContain('45 seconds');
	});

	it('recommends settling in the head first', () => {
		expect(describeCloseWithActiveWork(300n, 0, 10)).toMatch(/Settling inside the head first/);
	});

	/**
	 * Every comparison against NaN is false, so an unreadable period fell through
	 * to the days branch and told the operator to wait "NaN days". The column is
	 * non-nullable with a default, so this should not be reachable — but a number
	 * this message quotes is not the place to find that assumption was wrong.
	 */
	it('never renders a number it does not have', () => {
		for (const unreadable of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			const message = describeCloseWithActiveWork(unreadable, 0, 1);
			expect(message).not.toContain('NaN');
			expect(message).not.toContain('Infinity');
			expect(message).toContain('an unknown length');
		}
	});
});
