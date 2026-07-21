import { TransactionStatus } from '@/generated/prisma/client';
import { selectRecoveryTransaction } from './recovery-transaction';

function tx(id: string, status: TransactionStatus, txHash: string | null) {
	return { id, status, txHash };
}

describe('selectRecoveryTransaction', () => {
	it('prefers the most recent confirmed transaction', () => {
		const history = [tx('c2', TransactionStatus.Confirmed, 'hash-2'), tx('c1', TransactionStatus.Confirmed, 'hash-1')];

		expect(selectRecoveryTransaction(history)?.id).toBe('c2');
	});

	it('falls back to the most recent pending transaction', () => {
		const history = [tx('p1', TransactionStatus.Pending, 'hash-p')];

		expect(selectRecoveryTransaction(history)?.id).toBe('p1');
	});

	// The clobbered row: Pending, no hash, and the most recent. Selecting it
	// re-pins a hash-less CurrentTransaction AND shields it from
	// transactionsToFail, so the request can never leave the error state.
	it('skips a hash-less pending row and takes the older confirmed one', () => {
		const history = [
			tx('clobbered', TransactionStatus.Pending, null),
			tx('escrow', TransactionStatus.Confirmed, 'escrow-hash'),
		];

		expect(selectRecoveryTransaction(history)?.id).toBe('escrow');
	});

	it('skips a hash-less confirmed row', () => {
		const history = [
			tx('blanked', TransactionStatus.Confirmed, null),
			tx('good', TransactionStatus.Confirmed, 'good-hash'),
		];

		expect(selectRecoveryTransaction(history)?.id).toBe('good');
	});

	it('returns undefined when no candidate carries a hash', () => {
		const history = [tx('a', TransactionStatus.Pending, null), tx('b', TransactionStatus.Confirmed, null)];

		expect(selectRecoveryTransaction(history)).toBeUndefined();
	});

	it('ignores failed and rolled-back transactions', () => {
		const history = [
			tx('f', TransactionStatus.FailedViaManualReset, 'f-hash'),
			tx('r', TransactionStatus.RolledBack, 'r-hash'),
		];

		expect(selectRecoveryTransaction(history)).toBeUndefined();
	});

	it('returns undefined for an empty history', () => {
		expect(selectRecoveryTransaction([])).toBeUndefined();
	});
});
