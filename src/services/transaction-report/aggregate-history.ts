/**
 * Splitting a report into its daily, weekly or monthly buckets.
 *
 * The period totals live in `aggregate-rows.ts`. This module places each row's
 * money in the bucket its own accounting instant falls in, and marks a metric
 * partial wherever a row carries no usable date.
 */
import { addAmounts, getAtomicAmount, subtractAmounts } from './amounts';
import { addAggregateMetric as addMetric, readAggregateMetricAmounts as readMetricAmounts } from './aggregate-amounts';
import { getReportCountDates } from './aggregate-counts';
import type { FeeAnalysis } from './aggregate-fees';
import {
	combineCompleteness,
	createAggregate,
	hasAmounts,
	isProtocolMetricComplete,
	addRoleMetrics,
} from './aggregate-rows';
import type { AggregateMetricName, ReportDateBasis, ReportHistoryAggregate, ReportBucket } from './aggregate-types';
import { findLocalDateStart, getBucketLocalStart, getNextBucketLocalStart, type LocalDate } from './aggregate-calendar';
import { groupReportRowsByPayment } from './row-groups';
import type { ReportRow } from './records';
import { runReportCheckpoint, type ReportCheckpoint } from './checkpoint';

const MAX_HISTORY_BUCKETS = 10_000;

export type MutableHistoryAggregate = ReportHistoryAggregate & { transactionKeys: Set<string> };

export function createHistoryBuckets(
	from: Date,
	to: Date,
	bucket: ReportBucket,
	readLocalDate: (date: Date) => LocalDate,
	checkpoint: ReportCheckpoint,
): MutableHistoryAggregate[] {
	const history: MutableHistoryAggregate[] = [];
	let localStart = getBucketLocalStart(readLocalDate(from), bucket);
	for (let index = 0; index < MAX_HISTORY_BUCKETS; index += 1) {
		runReportCheckpoint(index, checkpoint);
		const nextLocalStart = getNextBucketLocalStart(localStart, bucket);
		const bucketStart = findLocalDateStart(localStart, readLocalDate);
		const bucketEnd = findLocalDateStart(nextLocalStart, readLocalDate);
		if (bucketStart.getTime() >= to.getTime()) return history;
		if (bucketEnd.getTime() > from.getTime() && bucketEnd.getTime() > bucketStart.getTime()) {
			history.push({ bucketStart, bucketEnd, metrics: createAggregate(), transactionKeys: new Set() });
		}
		localStart = nextLocalStart;
	}
	throw new RangeError(`Report history exceeds ${MAX_HISTORY_BUCKETS} buckets`);
}

function getEventBucket(
	date: Date | null,
	from: Date,
	to: Date,
	bucket: ReportBucket,
	readLocalDate: (date: Date) => LocalDate,
	historyByStart: ReadonlyMap<number, MutableHistoryAggregate>,
): MutableHistoryAggregate | null {
	if (date == null || date.getTime() < from.getTime() || date.getTime() >= to.getTime()) return null;
	const localStart = getBucketLocalStart(readLocalDate(date), bucket);
	return historyByStart.get(findLocalDateStart(localStart, readLocalDate).getTime()) ?? null;
}

/**
 * Counts every request once, on the one day `getReportCountDates` picked.
 *
 * Counting it on each day it touched would make the daily counts add up to more
 * than the period total, and anyone footing the column would find the two
 * disagreeing with no warning that they measure different things.
 */
export function recordHistoryCounts(
	rows: readonly ReportRow[],
	dateBasis: ReportDateBasis,
	from: Date,
	to: Date,
	bucket: ReportBucket,
	readLocalDate: (date: Date) => LocalDate,
	historyByStart: ReadonlyMap<number, MutableHistoryAggregate>,
): void {
	for (const [paymentKey, date] of getReportCountDates(rows, dateBasis, from, to)) {
		const entry = getEventBucket(date, from, to, bucket, readLocalDate, historyByStart);
		if (entry == null || entry.transactionKeys.has(paymentKey)) continue;
		entry.transactionKeys.add(paymentKey);
		entry.metrics.transactionCount += 1;
	}
}

export function markMetricPartial(history: readonly MutableHistoryAggregate[], metricName: AggregateMetricName): void {
	for (const entry of history) entry.metrics[metricName].completeness = 'partial';
}

function getCohortDate(row: ReportRow, dateBasis: Exclude<ReportDateBasis, 'RevenueRecognizedAt'>): Date | null {
	return dateBasis === 'CreatedAt' ? row.createdAt : row.timestamps.fundsLockedAt;
}

/**
 * Pending revenue is placed on the day the funds were locked.
 *
 * That is the only date the money is known to have, and it is the same date on
 * every date basis, so the pending line never moves when the basis changes.
 */
export function addPendingRevenueHistory(
	row: ReportRow,
	from: Date,
	to: Date,
	bucket: ReportBucket,
	readLocalDate: (date: Date) => LocalDate,
	historyByStart: ReadonlyMap<number, MutableHistoryAggregate>,
): void {
	if (row.seller == null || row.pendingRevenue.length === 0) return;
	const entry = getEventBucket(row.timestamps.fundsLockedAt, from, to, bucket, readLocalDate, historyByStart);
	if (entry == null) return;
	addMetric(entry.metrics.sellerPendingRevenue, row.pendingRevenue);
}

export function addCohortHistory(
	row: ReportRow,
	dateBasis: Exclude<ReportDateBasis, 'RevenueRecognizedAt'>,
	from: Date,
	to: Date,
	bucket: ReportBucket,
	readLocalDate: (date: Date) => LocalDate,
	historyByStart: ReadonlyMap<number, MutableHistoryAggregate>,
	missingTimestampMetrics: Set<AggregateMetricName>,
): void {
	const entry = getEventBucket(getCohortDate(row, dateBasis), from, to, bucket, readLocalDate, historyByStart);
	if (entry == null) {
		const metricNames: AggregateMetricName[] =
			row.role === 'Seller'
				? ['sellerGrossRevenue', 'protocolFees', 'sellerCardanoFees', 'sellerNetRevenue']
				: ['buyerGrossSpend', 'returnedFunds', 'buyerCardanoFees', 'buyerNetSpend'];
		for (const metricName of metricNames) missingTimestampMetrics.add(metricName);
		return;
	}
	addRoleMetrics(entry.metrics, row);
}

export function addSellerRevenueHistory(
	row: ReportRow,
	from: Date,
	to: Date,
	bucket: ReportBucket,
	readLocalDate: (date: Date) => LocalDate,
	historyByStart: ReadonlyMap<number, MutableHistoryAggregate>,
	missingTimestampMetrics: Set<AggregateMetricName>,
): void {
	if (row.seller == null) return;
	const date = row.timestamps.sellerRevenueRecognizedAt;
	if (date == null) {
		if (row.seller.grossRevenue == null || hasAmounts(row.seller.grossRevenue)) {
			missingTimestampMetrics.add('sellerGrossRevenue');
			missingTimestampMetrics.add('sellerNetRevenue');
		}
		if (hasAmounts(row.seller.protocolFee.amounts) || row.seller.protocolFee.completeness === 'insufficient_data') {
			missingTimestampMetrics.add('protocolFees');
			missingTimestampMetrics.add('sellerNetRevenue');
		}
	}
	const entry = getEventBucket(date, from, to, bucket, readLocalDate, historyByStart);
	if (entry == null) {
		if (row.actorCardanoFeeAllocation.historyCompleteness === 'partial') {
			missingTimestampMetrics.add('sellerCardanoFees');
			missingTimestampMetrics.add('sellerNetRevenue');
		}
		return;
	}
	const protocolCompleteness = isProtocolMetricComplete(row) ? 'complete' : 'partial';
	// A daily figure carries the history flag: an amount can be exact for the
	// period and still sit on the wrong day inside it.
	const actorFeeCompleteness = row.actorCardanoFeeAllocation.historyCompleteness;
	addMetric(entry.metrics.sellerGrossRevenue, row.seller.grossRevenue);
	addMetric(entry.metrics.protocolFees, row.seller.protocolFee.amounts ?? [], protocolCompleteness);
	addMetric(entry.metrics.sellerCardanoFees, row.seller.cardanoFees, actorFeeCompleteness);
	// The combined actor figure follows the same date as the side it came from,
	// so the daily fees add back up to the period total.
	addMetric(entry.metrics.actorCardanoFees, row.seller.cardanoFees, actorFeeCompleteness);
	addMetric(
		entry.metrics.sellerNetRevenue,
		row.seller.netRevenue,
		combineCompleteness(protocolCompleteness, actorFeeCompleteness),
	);
}

export function addBuyerRevenueHistory(
	row: ReportRow,
	from: Date,
	to: Date,
	bucket: ReportBucket,
	readLocalDate: (date: Date) => LocalDate,
	historyByStart: ReadonlyMap<number, MutableHistoryAggregate>,
	missingTimestampMetrics: Set<AggregateMetricName>,
): void {
	if (row.buyer == null) return;
	const grossEntry = getEventBucket(row.timestamps.buyerGrossSpendAt, from, to, bucket, readLocalDate, historyByStart);
	if (row.timestamps.buyerGrossSpendAt == null && (row.buyer.grossSpend == null || hasAmounts(row.buyer.grossSpend))) {
		missingTimestampMetrics.add('buyerGrossSpend');
		missingTimestampMetrics.add('buyerNetSpend');
	}
	if (grossEntry == null && row.actorCardanoFeeAllocation.historyCompleteness === 'partial') {
		missingTimestampMetrics.add('buyerCardanoFees');
		missingTimestampMetrics.add('buyerNetSpend');
	} else if (grossEntry != null) {
		addMetric(grossEntry.metrics.buyerGrossSpend, row.buyer.grossSpend);
		addMetric(
			grossEntry.metrics.buyerCardanoFees,
			row.buyer.cardanoFees,
			row.actorCardanoFeeAllocation.historyCompleteness,
		);
		addMetric(
			grossEntry.metrics.actorCardanoFees,
			row.buyer.cardanoFees,
			row.actorCardanoFeeAllocation.historyCompleteness,
		);
		addMetric(
			grossEntry.metrics.buyerNetSpend,
			row.buyer.grossSpend == null ? null : addAmounts(row.buyer.grossSpend, row.buyer.cardanoFees),
			row.actorCardanoFeeAllocation.historyCompleteness,
		);
	}

	const hasReturnedValue = hasAmounts(row.buyer.returnedFunds) || row.buyer.returnedFunds == null;
	const returnEntry = getEventBucket(row.timestamps.buyerReturnedAt, from, to, bucket, readLocalDate, historyByStart);
	if (row.timestamps.buyerReturnedAt == null && hasReturnedValue) {
		missingTimestampMetrics.add('returnedFunds');
		missingTimestampMetrics.add('buyerNetSpend');
	} else if (returnEntry != null) {
		addMetric(returnEntry.metrics.returnedFunds, row.buyer.returnedFunds);
		addMetric(
			returnEntry.metrics.buyerNetSpend,
			row.buyer.returnedFunds == null ? null : subtractAmounts([], row.buyer.returnedFunds),
			row.actorCardanoFeeAllocation.historyCompleteness,
		);
	}
}

export function addFeeHistory(
	rows: readonly ReportRow[],
	dateBasis: ReportDateBasis,
	fees: FeeAnalysis,
	from: Date,
	to: Date,
	bucket: ReportBucket,
	readLocalDate: (date: Date) => LocalDate,
	historyByStart: ReadonlyMap<number, MutableHistoryAggregate>,
	mutableHistory: readonly MutableHistoryAggregate[],
	checkpoint: ReportCheckpoint,
): boolean {
	const rowsByPayment = groupReportRowsByPayment(rows, checkpoint);
	const cohortBucketByPayment = new Map<string, MutableHistoryAggregate | null>();
	if (dateBasis !== 'RevenueRecognizedAt') {
		let paymentIndex = 0;
		for (const [paymentKey, paymentRows] of rowsByPayment) {
			runReportCheckpoint(paymentIndex, checkpoint);
			paymentIndex += 1;
			const entries = paymentRows.map((row) =>
				getEventBucket(getCohortDate(row, dateBasis), from, to, bucket, readLocalDate, historyByStart),
			);
			const starts = new Set(entries.map((entry) => entry?.bucketStart.getTime() ?? null));
			cohortBucketByPayment.set(paymentKey, starts.size === 1 ? entries[0] : null);
		}
	}
	let hasTotalHistoryGap = false;
	let hasAdminHistoryGap = false;
	let hasActorHistoryGap = false;
	for (const [index, component] of fees.components.entries()) {
		runReportCheckpoint(index, checkpoint);
		if (dateBasis === 'RevenueRecognizedAt') {
			for (const transaction of component.transactions) {
				const entry = getEventBucket(transaction.blockTime, from, to, bucket, readLocalDate, historyByStart);
				if (entry == null) {
					if (transaction.fee !== 0n) {
						hasTotalHistoryGap = true;
						if (component.isAdminComplete && component.actorFees === 0n) hasAdminHistoryGap = true;
					}
				} else if (transaction.fee !== 0n) {
					addMetric(entry.metrics.totalCardanoFees, [{ unit: 'lovelace', amount: transaction.fee }]);
					if (component.isAdminComplete && component.actorFees === 0n)
						addMetric(entry.metrics.adminCardanoFees, [{ unit: 'lovelace', amount: transaction.fee }]);
				}
			}
			if (component.isAdminComplete && component.actorFees !== 0n && component.admin !== 0n) {
				// The admin share is what is left after the actor counters, and those
				// counters cover a whole request rather than one transaction. So the
				// remainder cannot be split per transaction and goes, as an estimate,
				// on the day the component last moved.
				const settlement = component.transactions.reduce<Date | null>(
					(latest, transaction) =>
						transaction.blockTime != null && (latest == null || transaction.blockTime.getTime() > latest.getTime())
							? transaction.blockTime
							: latest,
					null,
				);
				const entry = getEventBucket(settlement, from, to, bucket, readLocalDate, historyByStart);
				if (entry == null || component.admin == null) hasAdminHistoryGap = true;
				else addMetric(entry.metrics.adminCardanoFees, [{ unit: 'lovelace', amount: component.admin }], 'partial');
			}
			// Actor fees are placed with the rows above, so only an unresolved
			// component is a gap here. The historyActor check below catches any
			// row whose fee found no bucket at all.
			if (!component.isActorComplete) hasActorHistoryGap = true;
			continue;
		}
		const ownerPaymentKeys = component.paymentKeys.filter((key) =>
			(rowsByPayment.get(key) ?? []).some((row) => row.isFeeReconciliationOwner),
		);
		const componentEntry =
			ownerPaymentKeys.length === 1 ? (cohortBucketByPayment.get(ownerPaymentKeys[0]) ?? null) : null;
		if (component.total !== 0n) {
			if (componentEntry == null) hasTotalHistoryGap = true;
			else
				addMetric(
					componentEntry.metrics.totalCardanoFees,
					[{ unit: 'lovelace', amount: component.total }],
					component.isTotalComplete ? 'complete' : 'partial',
				);
		}
		if (component.admin != null && component.admin !== 0n) {
			if (componentEntry == null) hasAdminHistoryGap = true;
			else addMetric(componentEntry.metrics.adminCardanoFees, [{ unit: 'lovelace', amount: component.admin }]);
		}
		if (component.actorFees !== 0n) {
			if (componentEntry == null) hasActorHistoryGap = true;
			else
				addMetric(
					componentEntry.metrics.actorCardanoFees,
					[{ unit: 'lovelace', amount: component.actorFees }],
					component.isActorComplete ? 'complete' : 'partial',
				);
		} else if (!component.isActorComplete) hasActorHistoryGap = true;
	}
	const historyActor = mutableHistory.reduce(
		(sum, entry) => sum + getAtomicAmount(readMetricAmounts(entry.metrics.actorCardanoFees), 'lovelace'),
		0n,
	);
	const historyTotal = mutableHistory.reduce(
		(sum, entry) => sum + getAtomicAmount(readMetricAmounts(entry.metrics.totalCardanoFees), 'lovelace'),
		0n,
	);
	const historyAdmin = mutableHistory.reduce(
		(sum, entry) => sum + getAtomicAmount(readMetricAmounts(entry.metrics.adminCardanoFees), 'lovelace'),
		0n,
	);
	const isTotalHistoryComplete =
		!hasTotalHistoryGap && fees.totalCompleteness === 'complete' && historyTotal === fees.total;
	const isAdminHistoryComplete =
		!hasAdminHistoryGap && fees.adminCompleteness === 'complete' && historyAdmin === fees.admin;
	const isActorHistoryComplete =
		!hasActorHistoryGap && fees.actorCompleteness === 'complete' && historyActor === fees.actor;
	if (!isActorHistoryComplete) markMetricPartial(mutableHistory, 'actorCardanoFees');
	if (!isTotalHistoryComplete) markMetricPartial(mutableHistory, 'totalCardanoFees');
	if (!isAdminHistoryComplete) markMetricPartial(mutableHistory, 'adminCardanoFees');
	return isActorHistoryComplete && isTotalHistoryComplete && isAdminHistoryComplete;
}
