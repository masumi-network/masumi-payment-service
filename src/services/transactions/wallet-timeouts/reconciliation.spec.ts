import { isTransactionNotFoundError, shouldRequeueMissingTransaction } from './reconciliation';

describe('wallet transaction reconciliation', () => {
	it('recognizes Blockfrost and local transaction-not-found errors', () => {
		expect(isTransactionNotFoundError('Transaction not found: abc')).toBe(true);
		expect(isTransactionNotFoundError('{"status":404,"data":{"message":"Not Found"}}')).toBe(true);
		expect(isTransactionNotFoundError('{"status_code":404,"message":"Not Found"}')).toBe(true);
		expect(isTransactionNotFoundError('{"status":500,"message":"Server error"}')).toBe(false);
	});

	it('requires both expiry and a prior not-found observation before requeueing', () => {
		const now = new Date('2026-07-12T12:10:00.000Z');
		const expiredCreatedAt = new Date('2026-07-12T12:00:00.000Z');
		const recentCreatedAt = new Date('2026-07-12T12:05:00.001Z');

		expect(
			shouldRequeueMissingTransaction({
				createdAt: expiredCreatedAt,
				lastCheckedAt: null,
				now,
				timeoutMs: 5 * 60 * 1000,
			}),
		).toBe(false);
		expect(
			shouldRequeueMissingTransaction({
				createdAt: recentCreatedAt,
				lastCheckedAt: new Date('2026-07-12T12:09:00.000Z'),
				now,
				timeoutMs: 5 * 60 * 1000,
			}),
		).toBe(false);
		expect(
			shouldRequeueMissingTransaction({
				createdAt: expiredCreatedAt,
				lastCheckedAt: new Date('2026-07-12T12:09:00.000Z'),
				now,
				timeoutMs: 5 * 60 * 1000,
			}),
		).toBe(true);
	});
});
