import { describe, expect, it } from '@jest/globals';
import { getAtomicAmount } from './amounts';
import {
	aggregateReportRows,
	chooseReportBucket,
	serializeReportAggregateResult,
	type ReportAggregate,
	type ReportAggregateMetric,
} from './aggregate';
import { buildReportRow, type ReportRequestRecord, type ReportRow } from './records';
import type { ReportOnChainState, RevenueMode } from './metrics';

const AS_OF = new Date('2026-12-31T00:00:00.000Z');

function blockTime(value: string): number {
	return Math.floor(new Date(value).getTime() / 1000);
}

function transaction(
	id: string,
	state: ReportOnChainState,
	time: string,
	fees = 0n,
	relatedRequestKeys?: readonly string[],
	relatedPaymentKeys?: readonly string[],
): ReportRequestRecord['transactions'][number] {
	return {
		id,
		txHash: `hash-${id}`,
		status: 'Confirmed',
		newOnChainState: state,
		blockTime: blockTime(time),
		fees,
		relatedRequestKeys,
		relatedPaymentKeys,
	};
}

function record(overrides: Partial<ReportRequestRecord> = {}): ReportRequestRecord {
	const result: ReportRequestRecord = {
		id: 'request-1',
		role: 'Seller',
		requestType: 'PaymentRequest',
		createdAt: new Date('2026-01-01T12:00:00.000Z'),
		blockchainIdentifier: 'chain-1',
		agentIdentifier: 'agent-1',
		agentName: 'Agent',
		onChainState: 'Withdrawn',
		metadata: null,
		managedWallet: {
			id: 'wallet-1',
			walletAddress: 'addr-wallet',
			walletVkey: 'wallet-vkey',
			collectionAddress: 'addr-collection',
			deletedAt: null,
		},
		counterpartyAddress: 'addr-counterparty',
		buyerReturnAddress: null,
		sellerReturnAddress: null,
		paymentSourceType: 'Web3CardanoV2',
		configuredFeeRatePermille: 50,
		resultHash: 'result-hash',
		unlockTime: BigInt(new Date('2026-01-02T00:00:00.000Z').getTime()),
		collateralReturnLovelace: 2_000_000n,
		requestedFunds: [{ unit: 'lovelace', amount: 100_000_000n }],
		withdrawnForBuyer: [],
		withdrawnForSeller: [],
		buyerPayoutCompleteness: 'complete',
		sellerPayoutCompleteness: 'complete',
		buyerCardanoFees: 0n,
		sellerCardanoFees: 0n,
		transactions: [transaction('withdraw', 'Withdrawn', '2026-01-02T12:00:00.000Z')],
		feeAllocationScope: 'single_request',
		isFeeReconciliationOwner: true,
		feeComponentScope: 'complete',
		...overrides,
	};
	return {
		...result,
		transactions: result.transactions.map((value) => ({
			...value,
			relatedRequestKeys:
				value.relatedRequestKeys === undefined ? [`${result.role}:${result.id}`] : value.relatedRequestKeys,
			relatedPaymentKeys:
				value.relatedPaymentKeys === undefined ? [result.blockchainIdentifier] : value.relatedPaymentKeys,
		})),
	};
}

function row(
	overrides: Partial<ReportRequestRecord> = {},
	revenueMode: RevenueMode = 'Billable',
	dateBasis: 'CreatedAt' | 'FundsLockedAt' | 'RevenueRecognizedAt' = 'CreatedAt',
	from = new Date('2026-01-01T00:00:00.000Z'),
	to = new Date('2027-01-01T00:00:00.000Z'),
): ReportRow {
	return buildReportRow(record(overrides), revenueMode, AS_OF, { dateBasis, from, to });
}

function amount(metric: ReportAggregateMetric, unit = 'lovelace'): bigint {
	return getAtomicAmount(metric.amounts, unit);
}

function historyAmount(
	result: ReturnType<typeof aggregateReportRows>,
	metricName: Exclude<keyof ReportAggregate, 'transactionCount' | 'transactionCountCompleteness'>,
	unit = 'lovelace',
): bigint {
	return result.history.reduce((total, entry) => total + amount(entry.metrics[metricName], unit), 0n);
}

describe('chooseReportBucket', () => {
	it('uses day through 30 days, week through 366 days, then month', () => {
		const from = new Date('2026-01-01T00:00:00.000Z');
		expect(chooseReportBucket(from, new Date('2026-01-31T00:00:00.000Z'), 'Auto')).toBe('Day');
		expect(chooseReportBucket(from, new Date('2026-02-01T00:00:00.000Z'), 'Auto')).toBe('Week');
		expect(chooseReportBucket(from, new Date('2027-01-03T00:00:00.000Z'), 'Auto')).toBe('Month');
	});

	it('rejects invalid and reversed ranges', () => {
		expect(() => chooseReportBucket(new Date('invalid'), new Date(), 'Auto')).toThrow('must be valid');
		expect(() =>
			chooseReportBucket(new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'), 'Day'),
		).toThrow('must be after');
	});
});

describe('aggregateReportRows pending revenue', () => {
	/** Locked, and the dispute window closes well after the report's as-of time. */
	const pending = (overrides: Partial<ReportRequestRecord> = {}) =>
		row({
			id: 'pending-1',
			onChainState: 'FundsLocked',
			unlockTime: BigInt(new Date('2027-06-01T00:00:00.000Z').getTime()),
			transactions: [transaction('lock', 'FundsLocked', '2026-01-02T12:00:00.000Z')],
			...overrides,
		});

	const aggregate = (rows: ReportRow[], dateBasis: 'CreatedAt' | 'FundsLockedAt' | 'RevenueRecognizedAt') =>
		aggregateReportRows(
			rows,
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-05T00:00:00.000Z'),
			dateBasis,
		);

	it('counts money that is locked but not earned yet', () => {
		const result = aggregate([pending()], 'CreatedAt');
		expect(amount(result.totals.sellerPendingRevenue)).toBe(100_000_000n);
		expect(amount(result.totals.sellerGrossRevenue)).toBe(0n);
	});

	it('counts nothing once the escrow has ended', () => {
		expect(amount(aggregate([row()], 'CreatedAt').totals.sellerPendingRevenue)).toBe(0n);
	});

	it('counts nothing once the dispute window has closed, because it is earned by then', () => {
		const earned = pending({
			onChainState: 'ResultSubmitted',
			unlockTime: BigInt(new Date('2026-01-03T00:00:00.000Z').getTime()),
			transactions: [
				transaction('lock', 'FundsLocked', '2026-01-02T12:00:00.000Z'),
				transaction('result', 'ResultSubmitted', '2026-01-02T18:00:00.000Z'),
			],
		});
		expect(amount(aggregate([earned], 'CreatedAt').totals.sellerPendingRevenue)).toBe(0n);
	});

	it('counts nothing without a confirmed lock, because the money is not proven to be in escrow', () => {
		const unproven = pending({ transactions: [] });
		expect(amount(aggregate([unproven], 'CreatedAt').totals.sellerPendingRevenue)).toBe(0n);
	});

	it('counts nothing for an invalid datum, which is a dead end rather than a wait', () => {
		expect(
			amount(aggregate([pending({ onChainState: 'FundsOrDatumInvalid' })], 'CreatedAt').totals.sellerPendingRevenue),
		).toBe(0n);
	});

	it.each(['CreatedAt', 'FundsLockedAt', 'RevenueRecognizedAt'] as const)(
		'places it on the day the funds were locked whatever the %s basis is',
		(dateBasis) => {
			// The request was created on 1 January and locked on 2 January. The
			// day it will be earned on has not happened, so the lock day is the
			// only date it has.
			const result = aggregate([pending()], dateBasis);
			const locked = result.history.find((entry) => entry.bucketStart.toISOString().startsWith('2026-01-02'));
			expect(amount(locked!.metrics.sellerPendingRevenue)).toBe(100_000_000n);
			expect(historyAmount(result, 'sellerPendingRevenue')).toBe(100_000_000n);
		},
	);
});

describe('aggregateReportRows totals', () => {
	it('marks an unknown FundsLocked date membership count partial', () => {
		const uncertain = row(
			{ role: 'Buyer', requestType: 'PurchaseRequest', onChainState: 'Withdrawn' },
			'Billable',
			'FundsLockedAt',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
		);
		const result = aggregateReportRows(
			[uncertain],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'FundsLockedAt',
		);

		expect(result.totals.transactionCount).toBe(0);
		expect(result.totals.transactionCountCompleteness).toBe('partial');
		expect(result.totals.buyerGrossSpend).toEqual({ amounts: [], completeness: 'partial' });
		expect(result.totals.totalCardanoFees).toEqual({ amounts: [], completeness: 'partial' });
		expect(result.wallets[0].metrics.transactionCountCompleteness).toBe('partial');
		expect(result.wallets[0].metrics.transactionCount).toBe(0);
		expect(result.history.every((entry) => entry.metrics.transactionCountCompleteness === 'partial')).toBe(true);
		expect(result.warnings.map((warning) => warning.code)).toContain('TRANSACTION_COUNT_PARTIAL');
	});

	it('does not count a missing transaction hash as proven date membership', () => {
		const missingHash = row(
			{
				transactions: [{ ...transaction('missing-hash', 'Withdrawn', '2026-01-02T12:00:00.000Z', 100n), txHash: null }],
			},
			'Billable',
			'RevenueRecognizedAt',
			new Date('2026-01-02T00:00:00.000Z'),
			new Date('2026-01-03T00:00:00.000Z'),
		);
		const result = aggregateReportRows(
			[missingHash],
			'Day',
			'Etc/UTC',
			new Date('2026-01-02T00:00:00.000Z'),
			new Date('2026-01-03T00:00:00.000Z'),
			'RevenueRecognizedAt',
		);

		expect(result.totals.transactionCount).toBe(0);
		expect(result.totals.transactionCountCompleteness).toBe('partial');
		expect(result.history[0].metrics.transactionCount).toBe(0);
	});

	it('counts distinct logical payments inside each wallet group', () => {
		const first = row({ id: 'duplicate-count-a', blockchainIdentifier: 'duplicate-count-chain' });
		const second = row({ id: 'duplicate-count-b', blockchainIdentifier: 'duplicate-count-chain' });
		const result = aggregateReportRows(
			[first, second],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.transactionCount).toBe(1);
		expect(result.wallets[0].metrics.transactionCount).toBe(1);
		expect(result.totals.transactionCountCompleteness).toBe('complete');
	});

	it('keeps exact BigInt totals and reduces detailed completeness', () => {
		const exactAdminRow = row({
			id: 'v1',
			paymentSourceType: 'Web3CardanoV1',
			requestedFunds: [{ unit: 'lovelace', amount: 9_007_199_254_740_993n }],
			sellerCardanoFees: 20n,
			transactions: [transaction('v1-withdraw', 'Withdrawn', '2026-01-02T12:00:00.000Z', 100n)],
		});
		const sharedRow = row({
			id: 'v2',
			blockchainIdentifier: 'chain-2',
			feeAllocationScope: 'shared_or_unknown',
			transactions: [transaction('v2-withdraw', 'Withdrawn', '2026-01-03T12:00:00.000Z', 500n)],
		});
		const result = aggregateReportRows(
			[exactAdminRow, sharedRow],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-05T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.transactionCount).toBe(2);
		expect(amount(result.totals.sellerGrossRevenue)).toBe(9_007_199_354_740_993n);
		expect(result.totals.protocolFees.completeness).toBe('partial');
		expect(amount(result.totals.adminCardanoFees)).toBe(0n);
		expect(amount(result.totals.totalCardanoFees)).toBe(600n);
		expect(result.totals.adminCardanoFees.completeness).toBe('partial');
		expect(result.totals.totalCardanoFees.completeness).toBe('complete');
		expect(result.totals.sellerNetRevenue.completeness).toBe('partial');

		const serialized = serializeReportAggregateResult(result);
		expect(serialized.totals.sellerGrossRevenue.amounts[0]).toMatchObject({
			rawAmount: '9007199354740993',
			decimalAmount: '9007199354.740993',
		});
		expect(() => JSON.stringify(serialized)).not.toThrow();
	});

	it('keeps the same managed wallet in separate buyer and seller groups', () => {
		const seller = row({ onChainState: null, transactions: [] }, 'RequestedGross');
		const buyer = row({
			id: 'request-2',
			role: 'Buyer',
			requestType: 'PurchaseRequest',
			blockchainIdentifier: 'chain-2',
			onChainState: 'FundsLocked',
			transactions: [transaction('lock', 'FundsLocked', '2026-01-02T08:00:00.000Z')],
		});
		const result = aggregateReportRows(
			[seller, buyer],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-03T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.wallets.map((wallet) => wallet.role)).toEqual(['Buyer', 'Seller']);
		expect(amount(result.wallets[0].metrics.buyerGrossSpend)).toBe(100_000_000n);
		expect(amount(result.wallets[1].metrics.sellerGrossRevenue)).toBe(100_000_000n);
		expect(result.wallets.every((wallet) => wallet.metrics.transactionCount === 1)).toBe(true);
	});

	it('deduplicates paired global transactions and flags conflicting reconciliation', () => {
		const sharedTransactions = [
			transaction('pair-lock', 'FundsLocked', '2026-01-01T12:00:00.000Z'),
			transaction('pair-withdraw', 'Withdrawn', '2026-01-02T12:00:00.000Z', 100n),
		];
		const seller = row({
			id: 'seller-pair',
			blockchainIdentifier: 'paired-chain',
			buyerCardanoFees: 10n,
			sellerCardanoFees: 20n,
			transactions: sharedTransactions,
			feeAllocationScope: 'shared_or_unknown',
		});
		const buyer = row({
			id: 'buyer-pair',
			role: 'Buyer',
			requestType: 'PurchaseRequest',
			blockchainIdentifier: 'paired-chain',
			buyerCardanoFees: 10n,
			sellerCardanoFees: 20n,
			transactions: sharedTransactions,
			feeAllocationScope: 'shared_or_unknown',
		});
		const exact = aggregateReportRows(
			[seller, buyer],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-03T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(exact.totals.transactionCount).toBe(1);
		// Both sides settled inside the window, so the actor counters are exact and
		// the admin share is the remainder: 100 paid, 30 by the two actors.
		expect(amount(exact.totals.actorCardanoFees)).toBe(30n);
		expect(amount(exact.totals.adminCardanoFees)).toBe(70n);
		expect(amount(exact.totals.totalCardanoFees)).toBe(100n);
		expect(exact.wallets.map((wallet) => wallet.metrics.transactionCount)).toEqual([1, 1]);
		expect(exact.wallets.reduce((total, wallet) => total + amount(wallet.metrics.totalCardanoFees), 0n)).toBe(100n);
		expect(exact.wallets.filter((wallet) => amount(wallet.metrics.totalCardanoFees) > 0n)).toHaveLength(1);

		const conflictingBuyer = row({
			id: 'buyer-pair',
			role: 'Buyer',
			requestType: 'PurchaseRequest',
			blockchainIdentifier: 'paired-chain',
			buyerCardanoFees: 11n,
			sellerCardanoFees: 20n,
			transactions: [
				transaction('pair-lock', 'FundsLocked', '2026-01-01T12:00:00.000Z'),
				transaction('pair-withdraw', 'Withdrawn', '2026-01-02T12:00:00.000Z', 110n),
			],
			feeAllocationScope: 'shared_or_unknown',
		});
		const conflict = aggregateReportRows(
			[seller, conflictingBuyer],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-03T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(conflict.totals.transactionCount).toBe(1);
		expect(amount(conflict.totals.totalCardanoFees)).toBe(0n);
		expect(amount(conflict.totals.adminCardanoFees)).toBe(0n);
		expect(conflict.totals.totalCardanoFees.completeness).toBe('partial');
		expect(conflict.totals.adminCardanoFees.completeness).toBe('partial');
	});

	it('keeps paired role wallet fee metrics complete for an exact zero fee', () => {
		const requestKeys = ['Seller:zero-pair-seller', 'Buyer:zero-pair-buyer'];
		const shared = transaction('zero-pair', 'Withdrawn', '2026-01-02T12:00:00.000Z', 0n, requestKeys, [
			'zero-pair-chain',
		]);
		const seller = row({
			id: 'zero-pair-seller',
			blockchainIdentifier: 'zero-pair-chain',
			transactions: [shared],
		});
		const buyer = row({
			id: 'zero-pair-buyer',
			role: 'Buyer',
			requestType: 'PurchaseRequest',
			blockchainIdentifier: 'zero-pair-chain',
			transactions: [shared],
		});
		const result = aggregateReportRows(
			[seller, buyer],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.wallets).toHaveLength(2);
		expect(result.wallets.every((wallet) => wallet.metrics.totalCardanoFees.completeness === 'complete')).toBe(true);
		expect(result.wallets.every((wallet) => wallet.metrics.adminCardanoFees.completeness === 'partial')).toBe(true);
	});

	it('assigns paired wallet fees to the unique reconciliation owner', () => {
		const requestKeys = ['Seller:owner-pair-seller', 'Buyer:owner-pair-buyer'];
		const shared = transaction('owner-pair', 'Withdrawn', '2026-01-02T12:00:00.000Z', 100n, requestKeys, [
			'owner-pair-chain',
		]);
		const seller = row({
			id: 'owner-pair-seller',
			blockchainIdentifier: 'owner-pair-chain',
			managedWallet: {
				id: 'aaa-seller-wallet',
				walletAddress: 'addr-seller',
				walletVkey: 'seller-vkey',
				collectionAddress: 'addr-seller-collection',
				deletedAt: null,
			},
			isFeeReconciliationOwner: false,
			transactions: [shared],
		});
		const buyer = row({
			id: 'owner-pair-buyer',
			role: 'Buyer',
			requestType: 'PurchaseRequest',
			blockchainIdentifier: 'owner-pair-chain',
			managedWallet: {
				id: 'zzz-buyer-wallet',
				walletAddress: 'addr-buyer',
				walletVkey: 'buyer-vkey',
				collectionAddress: 'addr-buyer-collection',
				deletedAt: null,
			},
			isFeeReconciliationOwner: true,
			transactions: [shared],
		});
		const result = aggregateReportRows(
			[seller, buyer],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);
		const sellerWallet = result.wallets.find((wallet) => wallet.managedWallet?.id === 'aaa-seller-wallet')!;
		const buyerWallet = result.wallets.find((wallet) => wallet.managedWallet?.id === 'zzz-buyer-wallet')!;

		expect(amount(sellerWallet.metrics.totalCardanoFees)).toBe(0n);
		expect(amount(sellerWallet.metrics.adminCardanoFees)).toBe(0n);
		expect(amount(buyerWallet.metrics.totalCardanoFees)).toBe(100n);
		expect(amount(buyerWallet.metrics.adminCardanoFees)).toBe(0n);
		expect(buyerWallet.metrics.totalCardanoFees.completeness).toBe('complete');
		expect(buyerWallet.metrics.adminCardanoFees.completeness).toBe('partial');
		// Sharing a fee between the requests it settled is how the report works,
		// not a shortfall in it, so it raises no note of its own.
		expect(result.warnings.map((warning) => warning.code)).not.toContain('SHARED_CARDANO_FEE_COMPONENT_ALLOCATION');
	});

	it('counts a covered V2 batch fee once when every related request is selected', () => {
		const relatedRequestKeys = ['Seller:seller-batch', 'Buyer:buyer-batch'];
		const batchTransaction = transaction(
			'batch-withdraw',
			'Withdrawn',
			'2026-01-02T12:00:00.000Z',
			500n,
			relatedRequestKeys,
		);
		const seller = row({
			id: 'seller-batch',
			blockchainIdentifier: 'seller-chain',
			transactions: [batchTransaction],
			feeAllocationScope: 'shared_or_unknown',
		});
		const buyer = row({
			id: 'buyer-batch',
			role: 'Buyer',
			requestType: 'PurchaseRequest',
			blockchainIdentifier: 'buyer-chain',
			onChainState: 'FundsLocked',
			transactions: [batchTransaction],
			feeAllocationScope: 'shared_or_unknown',
		});
		const result = aggregateReportRows(
			[seller, buyer],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.totalCardanoFees).toEqual({
			amounts: [{ unit: 'lovelace', amount: 500n }],
			completeness: 'complete',
		});
		expect(result.totals.adminCardanoFees).toEqual({
			amounts: [],
			completeness: 'partial',
		});
	});

	it('marks a share that rounds to zero as apportioned rather than read', () => {
		// Three requests share one lovelace of fee, so the shares are 1, 0, 0. The
		// report holds only the middle one. Its share is zero, but it is still a
		// share worked out by a rule, not a figure the chain recorded.
		const batchTransaction = transaction(
			'tiny-batch-withdraw',
			'Withdrawn',
			'2026-01-02T12:00:00.000Z',
			1n,
			['Seller:tiny-batch'],
			['chain-a', 'chain-b', 'chain-c'],
		);
		const result = aggregateReportRows(
			[
				row({
					id: 'tiny-batch',
					blockchainIdentifier: 'chain-b',
					transactions: [batchTransaction],
					feeAllocationScope: 'shared_or_unknown',
				}),
			],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.totalCardanoFees.completeness).toBe('partial');
	});

	it('keeps admin exact when a filtered counterpart is the same logical payment', () => {
		const seller = row({
			id: 'seller-filtered-batch',
			transactions: [
				transaction('filtered-batch', 'Withdrawn', '2026-01-02T12:00:00.000Z', 500n, [
					'Seller:seller-filtered-batch',
					'Buyer:filtered-out',
				]),
			],
			feeAllocationScope: 'shared_or_unknown',
		});
		const result = aggregateReportRows(
			[seller],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.totalCardanoFees).toEqual({
			amounts: [{ unit: 'lovelace', amount: 500n }],
			completeness: 'complete',
		});
		expect(result.totals.adminCardanoFees).toEqual({
			amounts: [],
			completeness: 'partial',
		});
		expect(result.warnings.map((warning) => warning.code)).toContain('CARDANO_FEE_COVERAGE_PARTIAL');
	});

	it('takes an equal share of a shared fee when a related logical payment is filtered out', () => {
		const seller = row({
			id: 'seller-logical-filter',
			transactions: [
				transaction(
					'logical-filter',
					'Withdrawn',
					'2026-01-02T12:00:00.000Z',
					500n,
					['Seller:seller-logical-filter'],
					['chain-1', 'filtered-chain'],
				),
			],
		});
		const result = aggregateReportRows(
			[seller],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		// The transaction settled two requests and the report holds one of them,
		// so the report owes half the fee. Half of 500 is exactly 250, and the
		// other half belongs to a request outside this report, so the figure is
		// exact for what the report covers.
		expect(result.totals.totalCardanoFees).toEqual({
			amounts: [{ unit: 'lovelace', amount: 250n }],
			completeness: 'complete',
		});
		// Admin fees stay unknown here for a separate reason: they are the total
		// less the actor fees, and this row's actor allocation is itself partial.
		expect(result.totals.adminCardanoFees).toEqual({ amounts: [], completeness: 'partial' });
	});

	it('keeps records without a managed wallet in an Unassigned role group', () => {
		const unassigned = row({ managedWallet: null });
		const result = aggregateReportRows(
			[unassigned],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.wallets).toHaveLength(1);
		expect(result.wallets[0].managedWallet).toBeNull();
		expect(result.wallets[0].role).toBe('Seller');
		expect(amount(result.wallets[0].metrics.sellerGrossRevenue)).toBe(100_000_000n);
	});

	it('subtracts both known actor fees for a seller-only reconciliation', () => {
		const seller = row({
			buyerCardanoFees: 10n,
			sellerCardanoFees: 20n,
			transactions: [transaction('seller-only', 'Withdrawn', '2026-01-02T12:00:00.000Z', 100n)],
		});
		const result = aggregateReportRows(
			[seller],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(amount(result.totals.totalCardanoFees)).toBe(100n);
		expect(result.totals.actorCardanoFees).toEqual({
			amounts: [{ unit: 'lovelace', amount: 30n }],
			completeness: 'partial',
		});
		expect(result.totals.adminCardanoFees).toEqual({
			amounts: [],
			completeness: 'partial',
		});
		expect(amount(result.wallets[0].metrics.actorCardanoFees)).toBe(30n);
		expect(historyAmount(result, 'actorCardanoFees')).toBe(30n);
	});

	it('requires a transaction hash for exact total coverage', () => {
		const withoutHash = transaction('without-hash', 'Withdrawn', '2026-01-02T12:00:00.000Z', 100n);
		const seller = row({ transactions: [{ ...withoutHash, txHash: null }] });
		const result = aggregateReportRows(
			[seller],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.totalCardanoFees).toEqual({ amounts: [], completeness: 'partial' });
		expect(result.totals.adminCardanoFees.completeness).toBe('partial');
	});

	it('excludes negative transaction fee evidence', () => {
		const seller = row();
		const withNegativeFee: ReportRow = {
			...seller,
			transactions: seller.transactions.map((value) => ({ ...value, fees: -1n })),
		};
		const result = aggregateReportRows(
			[withNegativeFee],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.totalCardanoFees).toEqual({ amounts: [], completeness: 'partial' });
		expect(result.totals.adminCardanoFees.completeness).toBe('partial');
	});

	it('marks a chain state without transaction evidence partial', () => {
		const missingEvidence = row({ transactions: [] });
		const result = aggregateReportRows(
			[missingEvidence],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.totalCardanoFees).toEqual({ amounts: [], completeness: 'partial' });
		expect(result.totals.adminCardanoFees.completeness).toBe('partial');
	});

	it('marks an on-chain state with only pending transaction evidence partial', () => {
		const pending = transaction('pending-only', 'FundsLocked', '2026-01-02T12:00:00.000Z', 100n);
		const pendingEvidence = row({ transactions: [{ ...pending, status: 'Pending' }] });
		const result = aggregateReportRows(
			[pendingEvidence],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.totalCardanoFees).toEqual({ amounts: [], completeness: 'partial' });
		expect(result.totals.adminCardanoFees.completeness).toBe('partial');
	});

	it('retains an exact admin subtotal when another transaction has unknown logical coverage', () => {
		const exact = row({
			id: 'exact-subtotal',
			blockchainIdentifier: 'exact-chain',
			sellerCardanoFees: 20n,
			transactions: [transaction('exact-subtotal-tx', 'Withdrawn', '2026-01-02T12:00:00.000Z', 100n)],
		});
		const unknown = row({
			id: 'unknown-shared',
			blockchainIdentifier: 'unknown-chain',
			transactions: [
				{
					...transaction('unknown-shared-tx', 'Withdrawn', '2026-01-02T12:00:00.000Z', 500n),
					relatedPaymentKeys: null,
				},
			],
		});
		const result = aggregateReportRows(
			[exact, unknown],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.totalCardanoFees).toEqual({
			amounts: [{ unit: 'lovelace', amount: 100n }],
			completeness: 'partial',
		});
		expect(result.totals.adminCardanoFees).toEqual({
			amounts: [],
			completeness: 'partial',
		});
		expect(result.wallets).toHaveLength(1);
		expect(result.wallets[0].metrics.totalCardanoFees).toEqual({
			amounts: [{ unit: 'lovelace', amount: 100n }],
			completeness: 'partial',
		});
		expect(result.wallets[0].metrics.adminCardanoFees).toEqual({
			amounts: [],
			completeness: 'partial',
		});
	});

	it('rejects conflicting same-role actor fee evidence for one logical payment', () => {
		const requestKeys = ['Seller:duplicate-seller-a', 'Seller:duplicate-seller-b'];
		const shared = transaction('duplicate-seller-tx', 'Withdrawn', '2026-01-02T12:00:00.000Z', 100n, requestKeys, [
			'duplicate-chain',
		]);
		const first = row({
			id: 'duplicate-seller-a',
			blockchainIdentifier: 'duplicate-chain',
			sellerCardanoFees: 20n,
			transactions: [shared],
		});
		const second = row({
			id: 'duplicate-seller-b',
			blockchainIdentifier: 'duplicate-chain',
			sellerCardanoFees: 25n,
			transactions: [shared],
		});
		const result = aggregateReportRows(
			[first, second],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-01-04T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.totalCardanoFees.completeness).toBe('complete');
		expect(result.totals.adminCardanoFees).toEqual({ amounts: [], completeness: 'partial' });
	});
});

describe('aggregateReportRows history', () => {
	it('counts a logical payment in the bucket of an in-range fee-only event', () => {
		const from = new Date('2026-03-02T00:00:00.000Z');
		const to = new Date('2026-03-03T00:00:00.000Z');
		const feeOnly = row(
			{
				transactions: [
					transaction('fee-only-lock', 'FundsLocked', '2026-03-01T12:00:00.000Z'),
					transaction('fee-only-refund-request', 'RefundRequested', '2026-03-02T12:00:00.000Z', 50n),
					transaction('fee-only-withdraw', 'Withdrawn', '2026-03-04T12:00:00.000Z'),
				],
			},
			'Billable',
			'RevenueRecognizedAt',
			from,
			to,
		);
		const result = aggregateReportRows([feeOnly], 'Day', 'Etc/UTC', from, to, 'RevenueRecognizedAt');

		expect(result.totals.transactionCount).toBe(1);
		expect(result.history[0].metrics.transactionCount).toBe(1);
		expect(amount(result.history[0].metrics.totalCardanoFees)).toBe(50n);
	});

	it('marks unplaced buyer gross and actor-fee history partial', () => {
		const from = new Date('2026-03-02T00:00:00.000Z');
		const to = new Date('2026-03-03T00:00:00.000Z');
		const buyer = row(
			{
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				buyerCardanoFees: 10n,
				transactions: [transaction('buyer-without-lock', 'Withdrawn', '2026-03-02T12:00:00.000Z', 50n)],
			},
			'Billable',
			'RevenueRecognizedAt',
			from,
			to,
		);
		const result = aggregateReportRows([buyer], 'Day', 'Etc/UTC', from, to, 'RevenueRecognizedAt');

		expect(result.history[0].metrics.buyerGrossSpend.completeness).toBe('partial');
		expect(result.history[0].metrics.buyerCardanoFees.completeness).toBe('partial');
		expect(result.history[0].metrics.buyerNetSpend.completeness).toBe('partial');
	});

	it('marks unplaced seller actor-fee history partial without changing gross completeness', () => {
		const from = new Date('2026-03-02T00:00:00.000Z');
		const to = new Date('2026-03-03T00:00:00.000Z');
		const seller = row(
			{
				onChainState: 'RefundRequested',
				sellerCardanoFees: 10n,
				transactions: [transaction('seller-refund-request', 'RefundRequested', '2026-03-02T12:00:00.000Z', 50n)],
			},
			'Billable',
			'RevenueRecognizedAt',
			from,
			to,
		);
		const result = aggregateReportRows([seller], 'Day', 'Etc/UTC', from, to, 'RevenueRecognizedAt');

		expect(result.history[0].metrics.sellerGrossRevenue.completeness).toBe('complete');
		expect(result.history[0].metrics.sellerCardanoFees.completeness).toBe('partial');
		expect(result.history[0].metrics.sellerNetRevenue.completeness).toBe('partial');
	});

	it('places buyer gross spend and returned funds on their separate chain events', () => {
		const buyer = row(
			{
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'RefundWithdrawn',
				requestedFunds: [{ unit: 'policyasset', amount: 1_000n }],
				transactions: [
					transaction('lock', 'FundsLocked', '2026-03-01T12:00:00.000Z'),
					transaction('refund', 'RefundWithdrawn', '2026-03-03T12:00:00.000Z'),
				],
			},
			'Billable',
			'RevenueRecognizedAt',
			new Date('2026-03-01T00:00:00.000Z'),
			new Date('2026-03-04T00:00:00.000Z'),
		);
		const result = aggregateReportRows(
			[buyer],
			'Day',
			'Etc/UTC',
			new Date('2026-03-01T00:00:00.000Z'),
			new Date('2026-03-04T00:00:00.000Z'),
			'RevenueRecognizedAt',
		);

		expect(amount(result.history[0].metrics.buyerGrossSpend, 'policyasset')).toBe(1_000n);
		expect(amount(result.history[0].metrics.buyerNetSpend, 'policyasset')).toBe(1_000n);
		expect(amount(result.history[1].metrics.buyerGrossSpend, 'policyasset')).toBe(0n);
		expect(amount(result.history[2].metrics.returnedFunds, 'policyasset')).toBe(1_000n);
		expect(amount(result.history[2].metrics.buyerNetSpend, 'policyasset')).toBe(-1_000n);
		// One request, counted once, on the first day it touched. The money still
		// splits across both chain events, but the count has to foot to the total.
		expect(result.history.map((entry) => entry.metrics.transactionCount)).toEqual([1, 0, 0]);
		expect(result.totals.transactionCount).toBe(1);
		expect(result.totals.buyerNetSpend.amounts).toEqual([]);
	});

	it('keeps refund-only revenue totals equal to history deltas', () => {
		const from = new Date('2026-03-03T00:00:00.000Z');
		const to = new Date('2026-03-04T00:00:00.000Z');
		const buyer = row(
			{
				id: 'refund-only',
				blockchainIdentifier: 'refund-only-chain',
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'RefundWithdrawn',
				requestedFunds: [{ unit: 'policyasset', amount: 1_000n }],
				buyerCardanoFees: 100n,
				feeAllocationScope: 'shared_or_unknown',
				feeComponentScope: 'partial',
				transactions: [
					transaction(
						'refund-only-lock',
						'FundsLocked',
						'2026-03-01T12:00:00.000Z',
						100n,
						['Buyer:refund-only', 'Buyer:old-sibling'],
						['refund-only-chain', 'old-sibling-chain'],
					),
					transaction('refund-only-return', 'RefundWithdrawn', '2026-03-03T12:00:00.000Z', 50n),
				],
			},
			'Billable',
			'RevenueRecognizedAt',
			from,
			to,
		);
		const result = aggregateReportRows([buyer], 'Day', 'Etc/UTC', from, to, 'RevenueRecognizedAt');

		expect(buyer.cardanoFeeReconciliation).toMatchObject({
			buyerCardanoFees: 0n,
			adminCardanoFees: null,
			totalCardanoFees: 50n,
			completeness: 'partial',
		});
		expect(amount(result.totals.totalCardanoFees)).toBe(buyer.cardanoFeeReconciliation.totalCardanoFees);
		expect(amount(result.totals.buyerGrossSpend, 'policyasset')).toBe(0n);
		expect(amount(result.totals.returnedFunds, 'policyasset')).toBe(1_000n);
		expect(amount(result.totals.buyerNetSpend, 'policyasset')).toBe(-1_000n);
		expect(historyAmount(result, 'buyerGrossSpend', 'policyasset')).toBe(0n);
		expect(historyAmount(result, 'returnedFunds', 'policyasset')).toBe(1_000n);
		expect(historyAmount(result, 'buyerNetSpend', 'policyasset')).toBe(-1_000n);
		expect(historyAmount(result, 'totalCardanoFees')).toBe(amount(result.totals.totalCardanoFees));
	});

	it.each(['CreatedAt', 'FundsLockedAt'] as const)(
		'keeps %s cohort totals equal to one deterministic history bucket',
		(dateBasis) => {
			const from = new Date('2026-01-01T00:00:00.000Z');
			const to = new Date('2026-01-04T00:00:00.000Z');
			const buyer = row(
				{
					id: 'cohort-refund',
					role: 'Buyer',
					requestType: 'PurchaseRequest',
					onChainState: 'RefundWithdrawn',
					requestedFunds: [{ unit: 'policyasset', amount: 1_000n }],
					buyerCardanoFees: 100n,
					transactions: [
						transaction('cohort-lock', 'FundsLocked', '2026-01-01T12:00:00.000Z', 100n),
						transaction('cohort-return', 'RefundWithdrawn', '2026-01-03T12:00:00.000Z', 50n),
					],
				},
				'Billable',
				dateBasis,
				from,
				to,
			);
			const result = aggregateReportRows([buyer], 'Day', 'Etc/UTC', from, to, dateBasis);

			for (const [metricName, unit] of [
				['buyerGrossSpend', 'policyasset'],
				['returnedFunds', 'policyasset'],
				['buyerCardanoFees', 'lovelace'],
				['buyerNetSpend', 'lovelace'],
				['adminCardanoFees', 'lovelace'],
				['totalCardanoFees', 'lovelace'],
			] as const) {
				expect(historyAmount(result, metricName, unit)).toBe(amount(result.totals[metricName], unit));
			}
			expect(result.history.filter((entry) => entry.metrics.transactionCount > 0)).toHaveLength(1);
		},
	);

	it('keeps two exact cohort reconciliations in their own January buckets', () => {
		const from = new Date('2026-01-01T00:00:00.000Z');
		const to = new Date('2026-02-01T00:00:00.000Z');
		const first = row({
			id: 'jan-first',
			blockchainIdentifier: 'jan-chain-first',
			createdAt: new Date('2026-01-05T12:00:00.000Z'),
			sellerCardanoFees: 20n,
			transactions: [transaction('jan-first-tx', 'Withdrawn', '2026-01-06T12:00:00.000Z', 100n)],
		});
		const second = row({
			id: 'jan-second',
			blockchainIdentifier: 'jan-chain-second',
			createdAt: new Date('2026-01-20T12:00:00.000Z'),
			sellerCardanoFees: 50n,
			transactions: [transaction('jan-second-tx', 'Withdrawn', '2026-01-21T12:00:00.000Z', 200n)],
		});
		const result = aggregateReportRows([first, second], 'Day', 'Etc/UTC', from, to, 'CreatedAt');
		const firstBucket = result.history.find((entry) => entry.bucketStart.toISOString() === '2026-01-05T00:00:00.000Z')!;
		const secondBucket = result.history.find(
			(entry) => entry.bucketStart.toISOString() === '2026-01-20T00:00:00.000Z',
		)!;

		expect(amount(firstBucket.metrics.totalCardanoFees)).toBe(100n);
		expect(amount(firstBucket.metrics.adminCardanoFees)).toBe(0n);
		expect(amount(secondBucket.metrics.totalCardanoFees)).toBe(200n);
		expect(amount(secondBucket.metrics.adminCardanoFees)).toBe(0n);
		expect(historyAmount(result, 'adminCardanoFees')).toBe(0n);
		expect(result.historyFeeCompleteness).toBe('partial');
	});

	it.each([
		{
			name: 'same bucket and wallet group',
			secondDate: '2026-01-05T18:00:00.000Z',
			secondWallet: 'same',
			expectedHistory: 500n,
			expectedWallet: 500n,
		},
		{
			name: 'different cohort buckets',
			secondDate: '2026-01-20T12:00:00.000Z',
			secondWallet: 'same',
			expectedHistory: 500n,
			expectedWallet: 500n,
		},
		{
			name: 'different wallet groups',
			secondDate: '2026-01-05T18:00:00.000Z',
			secondWallet: 'different',
			expectedHistory: 500n,
			expectedWallet: 500n,
		},
	])(
		'handles shared V2 logical payments in $name cohort buckets',
		({ secondDate, secondWallet, expectedHistory, expectedWallet }) => {
			const requestKeys = ['Seller:shared-first', 'Seller:shared-second'];
			const paymentKeys = ['shared-chain-first', 'shared-chain-second'];
			const shared = transaction('shared-v2', 'Withdrawn', '2026-01-10T12:00:00.000Z', 500n, requestKeys, paymentKeys);
			const first = row({
				id: 'shared-first',
				blockchainIdentifier: 'shared-chain-first',
				createdAt: new Date('2026-01-05T12:00:00.000Z'),
				transactions: [shared],
				feeAllocationScope: 'shared_or_unknown',
			});
			const second = row({
				id: 'shared-second',
				blockchainIdentifier: 'shared-chain-second',
				createdAt: new Date(secondDate),
				...(secondWallet === 'same'
					? {}
					: {
							managedWallet: {
								id: 'wallet-2',
								walletAddress: 'addr-wallet-2',
								walletVkey: 'wallet-vkey-2',
								collectionAddress: 'addr-collection-2',
								deletedAt: null,
							},
						}),
				transactions: [shared],
				feeAllocationScope: 'shared_or_unknown',
			});
			const result = aggregateReportRows(
				[first, second],
				'Day',
				'Etc/UTC',
				new Date('2026-01-01T00:00:00.000Z'),
				new Date('2026-02-01T00:00:00.000Z'),
				'CreatedAt',
			);

			expect(amount(result.totals.totalCardanoFees)).toBe(500n);
			expect(result.totals.totalCardanoFees.completeness).toBe('complete');
			expect(historyAmount(result, 'totalCardanoFees')).toBe(expectedHistory);
			expect(result.wallets.reduce((sum, wallet) => sum + amount(wallet.metrics.totalCardanoFees), 0n)).toBe(
				expectedWallet,
			);
			expect(result.historyFeeCompleteness).toBe('partial');
			expect(result.warnings.map((warning) => warning.code)).not.toContain(
				'SHARED_CARDANO_FEE_COMPONENT_ALLOCATION',
			);
		},
	);

	it('keeps exact zero shared fees complete across wallet and cohort boundaries', () => {
		const requestKeys = ['Seller:zero-shared-first', 'Seller:zero-shared-second'];
		const paymentKeys = ['zero-shared-chain-first', 'zero-shared-chain-second'];
		const shared = transaction('zero-shared', 'Withdrawn', '2026-01-10T12:00:00.000Z', 0n, requestKeys, paymentKeys);
		const first = row({
			id: 'zero-shared-first',
			blockchainIdentifier: 'zero-shared-chain-first',
			createdAt: new Date('2026-01-05T12:00:00.000Z'),
			transactions: [shared],
		});
		const second = row({
			id: 'zero-shared-second',
			blockchainIdentifier: 'zero-shared-chain-second',
			createdAt: new Date('2026-01-20T12:00:00.000Z'),
			managedWallet: {
				id: 'wallet-2',
				walletAddress: 'addr-wallet-2',
				walletVkey: 'wallet-vkey-2',
				collectionAddress: 'addr-collection-2',
				deletedAt: null,
			},
			transactions: [shared],
		});
		const result = aggregateReportRows(
			[first, second],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-02-01T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(result.totals.totalCardanoFees).toEqual({ amounts: [], completeness: 'complete' });
		expect(result.totals.adminCardanoFees).toEqual({ amounts: [], completeness: 'partial' });
		expect(result.wallets.every((wallet) => wallet.metrics.totalCardanoFees.completeness === 'complete')).toBe(true);
		expect(result.wallets.every((wallet) => wallet.metrics.adminCardanoFees.completeness === 'partial')).toBe(true);
		expect(result.history.every((entry) => entry.metrics.totalCardanoFees.completeness === 'complete')).toBe(true);
		expect(result.history.every((entry) => entry.metrics.adminCardanoFees.completeness === 'partial')).toBe(true);
		expect(result.historyFeeCompleteness).toBe('partial');
	});

	it('does not join positive fee components through a shared zero transaction', () => {
		const sharedZero = transaction(
			'mixed-shared-zero',
			'Withdrawn',
			'2026-01-10T12:00:00.000Z',
			0n,
			['Seller:mixed-first', 'Seller:mixed-second'],
			['mixed-chain-first', 'mixed-chain-second'],
		);
		const first = row({
			id: 'mixed-first',
			blockchainIdentifier: 'mixed-chain-first',
			createdAt: new Date('2026-01-05T12:00:00.000Z'),
			transactions: [
				transaction(
					'mixed-first-fee',
					'Withdrawn',
					'2026-01-05T12:00:00.000Z',
					100n,
					['Seller:mixed-first'],
					['mixed-chain-first'],
				),
				sharedZero,
			],
		});
		const second = row({
			id: 'mixed-second',
			blockchainIdentifier: 'mixed-chain-second',
			createdAt: new Date('2026-01-20T12:00:00.000Z'),
			managedWallet: {
				id: 'wallet-2',
				walletAddress: 'addr-wallet-2',
				walletVkey: 'wallet-vkey-2',
				collectionAddress: 'addr-collection-2',
				deletedAt: null,
			},
			transactions: [
				transaction(
					'mixed-second-fee',
					'Withdrawn',
					'2026-01-20T12:00:00.000Z',
					200n,
					['Seller:mixed-second'],
					['mixed-chain-second'],
				),
				sharedZero,
			],
		});
		const result = aggregateReportRows(
			[first, second],
			'Day',
			'Etc/UTC',
			new Date('2026-01-01T00:00:00.000Z'),
			new Date('2026-02-01T00:00:00.000Z'),
			'CreatedAt',
		);

		expect(amount(result.totals.totalCardanoFees)).toBe(300n);
		expect(amount(result.totals.adminCardanoFees)).toBe(0n);
		expect(result.totals.adminCardanoFees.completeness).toBe('partial');
		expect(result.wallets.map((wallet) => amount(wallet.metrics.totalCardanoFees))).toEqual([100n, 200n]);
		expect(result.wallets.map((wallet) => amount(wallet.metrics.adminCardanoFees))).toEqual([0n, 0n]);
		expect(historyAmount(result, 'totalCardanoFees')).toBe(300n);
		expect(historyAmount(result, 'adminCardanoFees')).toBe(0n);
		expect(result.historyFeeCompleteness).toBe('partial');
	});

	it('uses local calendar boundaries across a 23-hour DST day', () => {
		const seller = row(
			{
				onChainState: null,
				transactions: [],
				createdAt: new Date('2026-03-08T06:00:00.000Z'),
			},
			'RequestedGross',
		);
		const result = aggregateReportRows(
			[seller],
			'Day',
			'America/New_York',
			new Date('2026-03-08T05:00:00.000Z'),
			new Date('2026-03-10T04:00:00.000Z'),
			'RevenueRecognizedAt',
		);

		expect(result.history.map((entry) => [entry.bucketStart.toISOString(), entry.bucketEnd.toISOString()])).toEqual([
			['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
			['2026-03-09T04:00:00.000Z', '2026-03-10T04:00:00.000Z'],
		]);
		expect(result.history[0].bucketEnd.getTime() - result.history[0].bucketStart.getTime()).toBe(23 * 60 * 60 * 1000);
		expect(result.history[0].metrics.sellerGrossRevenue.amounts).toEqual([{ unit: 'lovelace', amount: 100_000_000n }]);
	});

	it.each([
		{
			bucket: 'Week' as const,
			from: '2026-01-07T00:00:00.000Z',
			to: '2026-01-13T00:00:00.000Z',
			expected: [
				['2026-01-05T00:00:00.000Z', '2026-01-12T00:00:00.000Z'],
				['2026-01-12T00:00:00.000Z', '2026-01-19T00:00:00.000Z'],
			],
		},
		{
			bucket: 'Month' as const,
			from: '2026-01-15T00:00:00.000Z',
			to: '2026-03-02T00:00:00.000Z',
			expected: [
				['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
				['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
				['2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
			],
		},
	])('builds $bucket calendar buckets', ({ bucket, from, to, expected }) => {
		const result = aggregateReportRows([], bucket, 'Etc/UTC', new Date(from), new Date(to), 'CreatedAt');
		expect(result.history.map((entry) => [entry.bucketStart.toISOString(), entry.bucketEnd.toISOString()])).toEqual(
			expected,
		);
	});

	it('places accounting-allocated actor fees in a deterministic revenue bucket', () => {
		const seller = row(
			{
				sellerCardanoFees: 200n,
				transactions: [transaction('withdraw-fee', 'Withdrawn', '2026-01-02T12:00:00.000Z', 300n)],
			},
			'Billable',
			'RevenueRecognizedAt',
			new Date('2026-01-02T00:00:00.000Z'),
			new Date('2026-01-03T00:00:00.000Z'),
		);
		const result = aggregateReportRows(
			[seller],
			'Day',
			'Etc/UTC',
			new Date('2026-01-02T00:00:00.000Z'),
			new Date('2026-01-03T00:00:00.000Z'),
			'RevenueRecognizedAt',
		);

		expect(amount(result.totals.sellerCardanoFees)).toBe(200n);
		expect(result.totals.sellerCardanoFees.completeness).toBe('partial');
		expect(result.history[0].metrics.sellerCardanoFees).toEqual({
			amounts: [{ unit: 'lovelace', amount: 200n }],
			completeness: 'partial',
		});
		expect(result.history[0].metrics.sellerNetRevenue.completeness).toBe('partial');
		expect(result.history[0].metrics.adminCardanoFees.completeness).toBe('partial');
		expect(amount(result.history[0].metrics.totalCardanoFees)).toBe(300n);
		expect(result.historyFeeCompleteness).toBe('partial');
		expect(result.warnings.map((warning) => warning.code)).toContain('HISTORY_ACTOR_CARDANO_FEE_ALLOCATION_PARTIAL');
	});

	it('runs a cancellation checkpoint during large synchronous aggregation', () => {
		const rows = Array.from({ length: 600 }, (_value, index) =>
			row({
				id: `checkpoint-${index}`,
				blockchainIdentifier: `checkpoint-chain-${index}`,
				transactions: [],
			}),
		);
		const stopped = new Error('stopped');
		let checks = 0;

		expect(() =>
			aggregateReportRows(
				rows,
				'Day',
				'Etc/UTC',
				new Date('2026-01-01T00:00:00.000Z'),
				new Date('2026-02-01T00:00:00.000Z'),
				'CreatedAt',
				() => {
					checks += 1;
					if (checks === 3) throw stopped;
				},
			),
		).toThrow(stopped);
		expect(checks).toBe(3);
	});
});

describe('aggregateReportRows fiat zero placeholders', () => {
	it('keeps history complete when an unfinished request carries only a zero fiat amount', () => {
		const from = new Date('2026-03-01T00:00:00.000Z');
		const to = new Date('2026-03-05T00:00:00.000Z');
		const pending = row(
			{
				onChainState: 'FundsLocked',
				transactions: [transaction('lock', 'FundsLocked', '2026-03-02T12:00:00.000Z')],
			},
			'Billable',
			'RevenueRecognizedAt',
			from,
			to,
		);
		const seller = pending.seller;
		if (seller == null) throw new Error('the fixture must carry a seller side');
		// Fiat conversion appends a zero fiat amount to every figure, empty ones included.
		const converted: ReportRow = {
			...pending,
			seller: { ...seller, grossRevenue: [{ unit: 'fiat:eur', amount: 0n }] },
		};

		const result = aggregateReportRows([converted], 'Day', 'Etc/UTC', from, to, 'RevenueRecognizedAt');

		for (const entry of result.history) {
			expect(entry.metrics.sellerGrossRevenue.completeness).toBe('complete');
		}
	});
});

describe('aggregateReportRows footing', () => {
	it('adds the daily counts and the daily actor fees back up to the period totals', () => {
		const from = new Date('2026-03-01T00:00:00.000Z');
		const to = new Date('2026-03-05T00:00:00.000Z');
		const seller = row(
			{
				sellerCardanoFees: 300_000n,
				transactions: [
					transaction('lock', 'FundsLocked', '2026-03-01T12:00:00.000Z'),
					transaction('withdraw', 'Withdrawn', '2026-03-03T12:00:00.000Z'),
				],
			},
			'Billable',
			'RevenueRecognizedAt',
			from,
			to,
		);
		const buyer = row(
			{
				id: 'request-2',
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				blockchainIdentifier: 'chain-2',
				buyerCardanoFees: 200_000n,
				transactions: [transaction('buyer-lock', 'FundsLocked', '2026-03-02T12:00:00.000Z')],
			},
			'Billable',
			'RevenueRecognizedAt',
			from,
			to,
		);
		const result = aggregateReportRows([seller, buyer], 'Day', 'Etc/UTC', from, to, 'RevenueRecognizedAt');

		const countSum = result.history.reduce((total, entry) => total + entry.metrics.transactionCount, 0);
		expect(countSum).toBe(result.totals.transactionCount);

		const metricNames = Object.keys(result.totals).filter(
			(key): key is Exclude<keyof ReportAggregate, 'transactionCount' | 'transactionCountCompleteness'> =>
				key !== 'transactionCount' && key !== 'transactionCountCompleteness',
		);
		expect(metricNames.length).toBeGreaterThan(0);
		for (const metricName of metricNames) {
			expect([metricName, historyAmount(result, metricName)]).toEqual([
				metricName,
				amount(result.totals[metricName]),
			]);
		}
	});
});
