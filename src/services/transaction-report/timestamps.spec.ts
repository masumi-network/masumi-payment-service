import { describe, expect, it } from '@jest/globals';
import {
	getReportTimestamps,
	hasConfirmedOnChainTransaction,
	hasConfirmedStateTransaction,
	mergeReportTransactions,
	sumPerRequestConfirmedTransactionFees,
	type ReportTransactionEvent,
} from './timestamps';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

function event(overrides: Partial<ReportTransactionEvent> = {}): ReportTransactionEvent {
	return {
		id: 'tx-1',
		txHash: 'hash-1',
		status: 'Confirmed',
		newOnChainState: 'FundsLocked',
		blockTime: 1_767_225_700,
		fees: 100_000n,
		relatedRequestKeys: ['Seller:request-1'],
		relatedPaymentKeys: ['chain-1'],
		...overrides,
	};
}

describe('report transaction timestamps', () => {
	it('uses the earliest confirmed FundsLocked block time', () => {
		const result = getReportTimestamps({
			createdAt,
			onChainState: 'Withdrawn',
			unlockTime: 1_767_226_000_000n,
			asOfTime: 1_767_230_000_000n,
			revenueMode: 'Billable',
			transactions: [
				event({ id: 'later', txHash: 'later', blockTime: 1_767_225_800 }),
				event({ id: 'earlier', txHash: 'earlier', blockTime: 1_767_225_700 }),
			],
		});
		expect(result.fundsLockedAt?.toISOString()).toBe('2026-01-01T00:01:40.000Z');
	});

	it('uses unlock time for projected ResultSubmitted revenue', () => {
		const result = getReportTimestamps({
			createdAt,
			onChainState: 'ResultSubmitted',
			unlockTime: 1_767_226_000_000n,
			asOfTime: 1_767_230_000_000n,
			revenueMode: 'Billable',
			transactions: [event({ newOnChainState: 'ResultSubmitted' })],
		});
		expect(result.sellerRevenueRecognizedAt?.toISOString()).toBe('2026-01-01T00:06:40.000Z');
	});

	it('keeps Billable revenue at unlock after a later withdrawal', () => {
		const transactions = [
			event({ id: 'result', txHash: 'result', newOnChainState: 'ResultSubmitted', blockTime: 1_767_225_800 }),
			event({ id: 'withdraw', txHash: 'withdraw', newOnChainState: 'Withdrawn', blockTime: 1_767_312_400 }),
		];
		const input = {
			createdAt,
			onChainState: 'Withdrawn' as const,
			unlockTime: 1_767_226_000_000n,
			asOfTime: 1_767_320_000_000n,
			transactions,
		};

		expect(getReportTimestamps({ ...input, revenueMode: 'Billable' }).sellerRevenueRecognizedAt?.toISOString()).toBe(
			'2026-01-01T00:06:40.000Z',
		);
		expect(
			getReportTimestamps({ ...input, revenueMode: 'CashReceived' }).sellerRevenueRecognizedAt?.toISOString(),
		).toBe('2026-01-02T00:06:40.000Z');
	});

	it.each([
		['wrong state', event()],
		['missing hash', event({ txHash: null, newOnChainState: 'ResultSubmitted' })],
		['pending', event({ status: 'Pending', newOnChainState: 'ResultSubmitted' })],
		['rolled back', event({ status: 'RolledBack', newOnChainState: 'ResultSubmitted' })],
	] as const)('does not project ResultSubmitted revenue from %s evidence', (_name, transaction) => {
		const result = getReportTimestamps({
			createdAt,
			onChainState: 'ResultSubmitted',
			unlockTime: 1_767_226_000_000n,
			asOfTime: 1_767_230_000_000n,
			revenueMode: 'Billable',
			transactions: [transaction],
		});
		expect(result.sellerRevenueRecognizedAt).toBeNull();
	});

	it('uses the terminal chain transition for settled seller revenue and buyer returns', () => {
		const result = getReportTimestamps({
			createdAt,
			onChainState: 'DisputedWithdrawn',
			unlockTime: 1_767_226_000_000n,
			asOfTime: 1_767_230_000_000n,
			revenueMode: 'CashReceived',
			transactions: [
				event(),
				event({
					id: 'tx-2',
					txHash: 'hash-2',
					newOnChainState: 'DisputedWithdrawn',
					blockTime: 1_767_226_300,
				}),
			],
		});
		expect(result.sellerRevenueRecognizedAt?.toISOString()).toBe('2026-01-01T00:11:40.000Z');
		expect(result.buyerReturnedAt?.toISOString()).toBe('2026-01-01T00:11:40.000Z');
	});

	it('uses creation time for requested gross revenue', () => {
		const result = getReportTimestamps({
			createdAt,
			onChainState: null,
			unlockTime: 1_767_226_000_000n,
			asOfTime: 1_767_230_000_000n,
			revenueMode: 'RequestedGross',
			transactions: [],
		});
		expect(result.sellerRevenueRecognizedAt).toEqual(createdAt);
		expect(result.buyerGrossSpendAt).toBeNull();
	});

	it('does not substitute database observation time for missing chain time', () => {
		const result = getReportTimestamps({
			createdAt,
			onChainState: 'Withdrawn',
			unlockTime: 1_767_226_000_000n,
			asOfTime: 1_767_230_000_000n,
			revenueMode: 'Billable',
			transactions: [event({ newOnChainState: 'Withdrawn', blockTime: null })],
		});
		expect(result.fundsLockedAt).toBeNull();
		expect(result.sellerRevenueRecognizedAt).toBeNull();
	});
});

describe('transaction history completeness', () => {
	it('merges many same-hash mirrors into one transaction', () => {
		const mirrors = Array.from({ length: 5_000 }, (_value, index) =>
			event({
				id: `mirror-${index}`,
				relatedRequestKeys: [`Seller:request-${index}`],
				relatedPaymentKeys: [`chain-${index}`],
			}),
		);

		const merged = mergeReportTransactions(mirrors);

		expect(merged).toHaveLength(1);
		expect(merged[0].relatedRequestKeys).toHaveLength(5_000);
		expect(merged[0].relatedPaymentKeys).toHaveLength(5_000);
	});

	it('requires a confirmed transaction hash', () => {
		expect(hasConfirmedOnChainTransaction([event()])).toBe(true);
		expect(hasConfirmedOnChainTransaction([event({ txHash: null })])).toBe(false);
		expect(hasConfirmedOnChainTransaction([event({ status: 'Pending' })])).toBe(false);
	});

	it('requires confirmed evidence for the exact requested state', () => {
		expect(hasConfirmedStateTransaction([event()], 'FundsLocked')).toBe(true);
		expect(hasConfirmedStateTransaction([event()], 'ResultSubmitted')).toBe(false);
		expect(hasConfirmedStateTransaction([event({ status: 'RolledBack' })], 'FundsLocked')).toBe(false);
	});

	it('deduplicates a shared transaction before summing fees', () => {
		expect(sumPerRequestConfirmedTransactionFees([event(), event({ id: 'duplicate' })], 'single_request')).toEqual({
			amount: 100_000n,
			completeness: 'complete',
		});
	});

	it('merges and sorts related request keys without row-order dependence', () => {
		const first = event({
			id: 'b',
			relatedRequestKeys: ['Seller:request-2', 'Buyer:request-1'],
			relatedPaymentKeys: ['chain-2', 'chain-1'],
		});
		const second = event({
			id: 'a',
			relatedRequestKeys: ['Buyer:request-1', 'Seller:request-1'],
			relatedPaymentKeys: ['chain-3', 'chain-1'],
		});
		const expected = [
			expect.objectContaining({
				id: 'a',
				relatedRequestKeys: ['Buyer:request-1', 'Seller:request-1', 'Seller:request-2'],
				relatedPaymentKeys: ['chain-1', 'chain-2', 'chain-3'],
			}),
		];

		expect(mergeReportTransactions([first, second])).toEqual(expected);
		expect(mergeReportTransactions([second, first])).toEqual(expected);
	});

	it('keeps unknown related requests nullable in merged evidence', () => {
		expect(mergeReportTransactions([event({ relatedRequestKeys: null, relatedPaymentKeys: null })])).toEqual([
			expect.objectContaining({ relatedRequestKeys: null, relatedPaymentKeys: null }),
		]);
	});

	it('marks a confirmed transaction with missing fees as partial', () => {
		expect(sumPerRequestConfirmedTransactionFees([event({ fees: null })], 'single_request')).toEqual({
			amount: null,
			completeness: 'partial',
		});
	});

	it('refuses to assign whole shared transaction fees to one request', () => {
		expect(sumPerRequestConfirmedTransactionFees([event()], 'shared_or_unknown')).toEqual({
			amount: null,
			completeness: 'partial',
		});
	});

	it('merges duplicate evidence without depending on row order', () => {
		const incomplete = event({ id: 'a', blockTime: null, fees: null });
		const complete = event({ id: 'b' });
		expect(sumPerRequestConfirmedTransactionFees([incomplete, complete], 'single_request')).toEqual({
			amount: 100_000n,
			completeness: 'complete',
		});
		expect(sumPerRequestConfirmedTransactionFees([complete, incomplete], 'single_request')).toEqual({
			amount: 100_000n,
			completeness: 'complete',
		});
	});

	it('allows Pending evidence to advance to Confirmed', () => {
		expect(hasConfirmedOnChainTransaction([event({ id: 'pending', status: 'Pending' }), event()])).toBe(true);
	});

	it('does not book conflicting terminal transaction statuses', () => {
		const transactions = [event(), event({ id: 'rolled-back', status: 'RolledBack' })];
		expect(hasConfirmedOnChainTransaction(transactions)).toBe(false);
		expect(sumPerRequestConfirmedTransactionFees(transactions, 'single_request')).toEqual({
			amount: null,
			completeness: 'partial',
		});
	});

	it('marks conflicting duplicate fee evidence as partial', () => {
		expect(
			sumPerRequestConfirmedTransactionFees([event(), event({ id: 'conflict', fees: 200_000n })], 'single_request'),
		).toEqual({ amount: null, completeness: 'partial' });
	});

	it('sums only transaction fees inside a revenue-recognized window', () => {
		expect(
			sumPerRequestConfirmedTransactionFees(
				[
					event({ id: 'outside', txHash: 'outside', blockTime: 1_767_225_700, fees: 100_000n }),
					event({ id: 'inside', txHash: 'inside', blockTime: 1_767_398_500, fees: 50_000n }),
				],
				'single_request',
				{
					dateBasis: 'RevenueRecognizedAt',
					from: new Date('2026-01-03T00:00:00.000Z'),
					to: new Date('2026-01-04T00:00:00.000Z'),
				},
				'chain-1',
			),
		).toEqual({ amount: 50_000n, completeness: 'complete' });
	});

	it('marks an in-scope confirmed fee with missing block time partial', () => {
		expect(
			sumPerRequestConfirmedTransactionFees(
				[event({ blockTime: null })],
				'single_request',
				{
					dateBasis: 'RevenueRecognizedAt',
					from: new Date('2026-01-03T00:00:00.000Z'),
					to: new Date('2026-01-04T00:00:00.000Z'),
				},
				'chain-1',
			),
		).toEqual({ amount: null, completeness: 'partial' });
	});

	it('ignores shared allocation evidence outside a revenue-recognized window', () => {
		expect(
			sumPerRequestConfirmedTransactionFees(
				[
					event({
						id: 'outside-shared',
						txHash: 'outside-shared',
						blockTime: 1_767_225_700,
						fees: 100_000n,
						relatedPaymentKeys: ['chain-1', 'chain-2'],
					}),
					event({ id: 'inside-single', txHash: 'inside-single', blockTime: 1_767_398_500, fees: 50_000n }),
				],
				'shared_or_unknown',
				{
					dateBasis: 'RevenueRecognizedAt',
					from: new Date('2026-01-03T00:00:00.000Z'),
					to: new Date('2026-01-04T00:00:00.000Z'),
				},
				'chain-1',
			),
		).toEqual({ amount: 50_000n, completeness: 'complete' });
	});

	it.each([
		['CreatedAt', undefined],
		[
			'RevenueRecognizedAt',
			{
				dateBasis: 'RevenueRecognizedAt' as const,
				from: new Date('2026-01-01T00:00:00.000Z'),
				to: new Date('2026-01-02T00:00:00.000Z'),
			},
		],
	])('treats a confirmed shared zero fee as complete for %s', (_dateBasis, window) => {
		expect(
			sumPerRequestConfirmedTransactionFees(
				[event({ fees: 0n, relatedPaymentKeys: ['chain-1', 'chain-2'] })],
				'shared_or_unknown',
				window,
				'chain-1',
			),
		).toEqual({ amount: 0n, completeness: 'complete' });
	});
});
