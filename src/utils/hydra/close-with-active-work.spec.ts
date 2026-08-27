import { describeCloseWithActiveWork } from '@/utils/hydra/close-with-active-work';

describe('describeCloseWithActiveWork', () => {
	// The old wording opened with "Cannot close", which was never true: closing
	// with live escrows is offered and always has been.
	it('does not claim the head cannot be closed', () => {
		const message = describeCloseWithActiveWork(300n, {
			pendingL2Transactions: 1,
			activeEscrows: 71,
			unrecoveredDeposits: 0,
		});
		expect(message).not.toMatch(/cannot/i);
		expect(message).toMatch(/Closing now/);
	});

	it('reports both counts when both are present', () => {
		const message = describeCloseWithActiveWork(300n, {
			pendingL2Transactions: 3,
			activeEscrows: 71,
			unrecoveredDeposits: 0,
		});
		expect(message).toContain('71 escrows still holding funds');
		expect(message).toContain('3 transactions still in flight');
	});

	// A head with escrows and nothing in flight should not be told about zero
	// transactions — it reads as a second, separate problem.
	it('omits a count that is zero', () => {
		const message = describeCloseWithActiveWork(300n, {
			pendingL2Transactions: 0,
			activeEscrows: 50,
			unrecoveredDeposits: 0,
		});
		expect(message).toContain('50 escrows still holding funds');
		expect(message).not.toContain('transaction');
	});

	it('uses singular wording for one', () => {
		const message = describeCloseWithActiveWork(300n, {
			pendingL2Transactions: 1,
			activeEscrows: 1,
			unrecoveredDeposits: 0,
		});
		expect(message).toContain('1 escrow still holding funds');
		expect(message).toContain('1 transaction still in flight');
	});

	// The wait is the whole reason to hesitate, so it has to be a duration an
	// operator can weigh rather than a number of seconds they convert.
	it('states the contestation period in readable units', () => {
		expect(
			describeCloseWithActiveWork(300n, { pendingL2Transactions: 0, activeEscrows: 1, unrecoveredDeposits: 0 }),
		).toContain('5 minutes');
		expect(
			describeCloseWithActiveWork(43_200n, { pendingL2Transactions: 0, activeEscrows: 1, unrecoveredDeposits: 0 }),
		).toContain('12 hours');
		expect(
			describeCloseWithActiveWork(432_000n, { pendingL2Transactions: 0, activeEscrows: 1, unrecoveredDeposits: 0 }),
		).toContain('5 days');
		expect(
			describeCloseWithActiveWork(45n, { pendingL2Transactions: 0, activeEscrows: 1, unrecoveredDeposits: 0 }),
		).toContain('45 seconds');
	});

	it('recommends settling in the head first', () => {
		expect(
			describeCloseWithActiveWork(300n, { pendingL2Transactions: 0, activeEscrows: 10, unrecoveredDeposits: 0 }),
		).toMatch(/Settling inside the head first/);
	});

	/**
	 * Every comparison against NaN is false, so an unreadable period fell through
	 * to the days branch and told the operator to wait "NaN days". The column is
	 * non-nullable with a default, so this should not be reachable — but a number
	 * this message quotes is not the place to find that assumption was wrong.
	 */
	it('never renders a number it does not have', () => {
		for (const unreadable of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			const message = describeCloseWithActiveWork(unreadable, {
				pendingL2Transactions: 0,
				activeEscrows: 1,
				unrecoveredDeposits: 0,
			});
			expect(message).not.toContain('NaN');
			expect(message).not.toContain('Infinity');
			expect(message).toContain('an unknown length');
		}
	});
});

// The reader behind the pre-close DIALOG once passed only two of the three
// counts. `hasActiveWork` still counted the deposit, so the dialog appeared,
// described a head holding nothing, and offered the acknowledgement that
// pre-authorises the close — the server's refusal never fired, because the UI
// had already answered it.
describe('a head whose only outstanding work is a deposit', () => {
	it('names the deposit rather than describing an empty head', () => {
		const message = describeCloseWithActiveWork(300n, {
			pendingL2Transactions: 0,
			activeEscrows: 0,
			unrecoveredDeposits: 1,
		});

		expect(message).not.toContain('This head has .');
		expect(message).toContain('1 deposit the head has not taken');
		expect(message).toContain('NOT come back in the fanout');
	});

	// Recovery opens a deposit period after absorption closes, so for a deposit
	// made in the last half hour the remedy the message names is not yet
	// available. Left unsaid, the operator's rational read is "recovery is
	// impossible, tick the box".
	it('says the wait is the protocol rather than a fault', () => {
		const message = describeCloseWithActiveWork(300n, {
			pendingL2Transactions: 0,
			activeEscrows: 0,
			unrecoveredDeposits: 2,
		});

		expect(message).toContain('one deposit period after the absorption window closes');
		expect(message).toContain('Leave the head enabled');
	});

	it('says nothing at all for a head that holds nothing', () => {
		expect(
			describeCloseWithActiveWork(300n, {
				pendingL2Transactions: 0,
				activeEscrows: 0,
				unrecoveredDeposits: 0,
			}),
		).toBe('');
	});
});
