import { isTransactionNotFoundError, shouldRequeueMissingTransaction } from './reconciliation';

describe('wallet transaction reconciliation', () => {
	it('recognizes Blockfrost and local transaction-not-found errors', () => {
		expect(isTransactionNotFoundError('Transaction not found: abc')).toBe(true);
		expect(isTransactionNotFoundError('{"status":404,"data":{"message":"Not Found"}}')).toBe(true);
		expect(isTransactionNotFoundError('{"status_code":404,"message":"Not Found"}')).toBe(true);
		expect(isTransactionNotFoundError('{"status":500,"message":"Server error"}')).toBe(false);
	});

	it('requires persisted chain expiry and a prior not-found observation before requeueing', () => {
		expect(
			shouldRequeueMissingTransaction({
				lastCheckedAt: null,
				invalidHereafterSlot: 1000n,
				currentSlot: 1100,
			}),
		).toBe(false);
		expect(
			shouldRequeueMissingTransaction({
				lastCheckedAt: new Date('2026-07-12T12:09:00.000Z'),
				invalidHereafterSlot: null,
				currentSlot: 1100,
			}),
		).toBe(false);
		expect(
			shouldRequeueMissingTransaction({
				lastCheckedAt: new Date('2026-07-12T12:09:00.000Z'),
				invalidHereafterSlot: 1000n,
				currentSlot: 1060,
			}),
		).toBe(false);
		expect(
			shouldRequeueMissingTransaction({
				lastCheckedAt: new Date('2026-07-12T12:09:00.000Z'),
				invalidHereafterSlot: 1000n,
				currentSlot: 1061,
			}),
		).toBe(true);
	});
});
