import { addAmounts, getAtomicAmount, subtractAmounts, type AtomicAmount } from './amounts';
import {
	addAggregateMetric as addMetric,
	createAggregateMetric as createMetric,
	finalizeReportAggregate as finalizeAggregate,
	readAggregateMetricAmounts as readMetricAmounts,
} from './aggregate-amounts';
import { getReportCountDates, getReportTransactionCount } from './aggregate-counts';
import { analyzeReportFees, assignCompleteReportFeeReconciliation, type FeeAnalysis } from './aggregate-fees';
import type { ReportMetricWindow, ReportRow, ReportWarning } from './records';
import { groupReportRowsByPayment } from './row-groups';
import { NO_REPORT_CHECKPOINT, runReportCheckpoint, type ReportCheckpoint } from './checkpoint';

export { serializeReportAggregateResult } from './aggregate-serialization';

export type ReportBucket = 'Day' | 'Week' | 'Month';
export type RequestedReportBucket = 'Auto' | ReportBucket;
export type ReportMetricCompleteness = 'complete' | 'partial';

export type ReportAggregateMetric = {
	amounts: AtomicAmount[];
	completeness: ReportMetricCompleteness;
};

export type ReportAggregate = {
	transactionCount: number;
	transactionCountCompleteness: ReportMetricCompleteness;
	sellerGrossRevenue: ReportAggregateMetric;
	sellerPendingRevenue: ReportAggregateMetric;
	protocolFees: ReportAggregateMetric;
	sellerCardanoFees: ReportAggregateMetric;
	actorCardanoFees: ReportAggregateMetric;
	adminCardanoFees: ReportAggregateMetric;
	totalCardanoFees: ReportAggregateMetric;
	sellerNetRevenue: ReportAggregateMetric;
	buyerGrossSpend: ReportAggregateMetric;
	returnedFunds: ReportAggregateMetric;
	buyerCardanoFees: ReportAggregateMetric;
	buyerNetSpend: ReportAggregateMetric;
};

export type ReportWalletAggregate = {
	managedWallet: ReportRow['managedWallet'];
	role: ReportRow['role'];
	metrics: ReportAggregate;
};

export type ReportHistoryAggregate = {
	bucketStart: Date;
	bucketEnd: Date;
	metrics: ReportAggregate;
};

export type ReportAggregateResult = {
	totals: ReportAggregate;
	wallets: ReportWalletAggregate[];
	history: ReportHistoryAggregate[];
	bucket: ReportBucket;
	warnings: ReportWarning[];
	historyFeeCompleteness: ReportMetricCompleteness;
};

type AggregateMetricName = Exclude<keyof ReportAggregate, 'transactionCount' | 'transactionCountCompleteness'>;
type ReportDateBasis = ReportMetricWindow['dateBasis'];
type LocalDate = Readonly<{ year: number; month: number; day: number }>;
type MutableHistoryAggregate = ReportHistoryAggregate & { transactionKeys: Set<string> };

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_BUCKETS = 10_000;
const DATE_BOUNDARY_SEARCH_HOURS = 36;

function createAggregate(): ReportAggregate {
	return {
		transactionCount: 0,
		transactionCountCompleteness: 'complete',
		sellerGrossRevenue: createMetric(),
		sellerPendingRevenue: createMetric(),
		protocolFees: createMetric(),
		sellerCardanoFees: createMetric(),
		actorCardanoFees: createMetric(),
		adminCardanoFees: createMetric(),
		totalCardanoFees: createMetric(),
		sellerNetRevenue: createMetric(),
		buyerGrossSpend: createMetric(),
		returnedFunds: createMetric(),
		buyerCardanoFees: createMetric(),
		buyerNetSpend: createMetric(),
	};
}

/**
 * Does this figure actually carry money?
 *
 * A zero entry is not money. Fiat conversion appends a zero fiat amount to
 * every figure, including empty ones, so counting entries alone would read an
 * empty figure as unplaced money and mark the whole history partial.
 */
function hasAmounts(amounts: readonly AtomicAmount[] | null): boolean {
	return amounts != null && amounts.some((amount) => amount.amount !== 0n);
}

function isProtocolMetricComplete(row: ReportRow): boolean {
	return row.seller?.protocolFee.completeness === 'exact' || row.seller?.protocolFee.completeness === 'not_applicable';
}

function combineCompleteness(...values: ReportMetricCompleteness[]): ReportMetricCompleteness {
	return values.every((value) => value === 'complete') ? 'complete' : 'partial';
}

/**
 * Money locked in escrow that the seller has not earned yet.
 *
 * It is kept out of the role metrics on purpose: it is not revenue, and a
 * cohort history must not place it on an accounting date it does not have.
 */
function addPendingRevenue(aggregate: ReportAggregate, row: ReportRow): void {
	if (row.seller == null) return;
	addMetric(aggregate.sellerPendingRevenue, row.pendingRevenue);
}

function addRoleMetrics(aggregate: ReportAggregate, row: ReportRow): void {
	if (row.seller != null) {
		const protocolCompleteness = isProtocolMetricComplete(row) ? 'complete' : 'partial';
		const actorFeeCompleteness = row.actorCardanoFeeAllocation.completeness;
		addMetric(aggregate.sellerGrossRevenue, row.seller.grossRevenue);
		addMetric(aggregate.protocolFees, row.seller.protocolFee.amounts ?? [], protocolCompleteness);
		addMetric(aggregate.sellerCardanoFees, row.seller.cardanoFees, actorFeeCompleteness);
		addMetric(
			aggregate.sellerNetRevenue,
			row.seller.netRevenue,
			combineCompleteness(protocolCompleteness, actorFeeCompleteness),
		);
	}
	if (row.buyer != null) {
		const actorFeeCompleteness = row.actorCardanoFeeAllocation.completeness;
		addMetric(aggregate.buyerGrossSpend, row.buyer.grossSpend);
		addMetric(aggregate.returnedFunds, row.buyer.returnedFunds);
		addMetric(aggregate.buyerCardanoFees, row.buyer.cardanoFees, actorFeeCompleteness);
		addMetric(aggregate.buyerNetSpend, row.buyer.netSpend, actorFeeCompleteness);
	}
}

function setFeeReconciliation(aggregate: ReportAggregate, analysis: FeeAnalysis): void {
	addMetric(
		aggregate.actorCardanoFees,
		analysis.actor === 0n ? [] : [{ unit: 'lovelace', amount: analysis.actor }],
		analysis.actorCompleteness,
	);
	addMetric(
		aggregate.totalCardanoFees,
		analysis.total === 0n ? [] : [{ unit: 'lovelace', amount: analysis.total }],
		analysis.totalCompleteness,
	);
	addMetric(
		aggregate.adminCardanoFees,
		analysis.admin === 0n ? [] : [{ unit: 'lovelace', amount: analysis.admin }],
		analysis.adminCompleteness,
	);
}

function aggregateGlobalRows(
	rows: readonly ReportRow[],
	dateBasis: ReportDateBasis,
	from: Date,
	to: Date,
	checkpoint: ReportCheckpoint,
): { metrics: ReportAggregate; fees: FeeAnalysis } {
	const aggregate = createAggregate();
	for (const [index, row] of rows.entries()) {
		runReportCheckpoint(index, checkpoint);
		addRoleMetrics(aggregate, row);
		addPendingRevenue(aggregate, row);
	}
	Object.assign(aggregate, getReportTransactionCount(rows, dateBasis, from, to));
	const fees = analyzeReportFees(rows, dateBasis, from, to, checkpoint);
	setFeeReconciliation(aggregate, fees);
	return { metrics: aggregate, fees };
}

function assertValidRange(from: Date, to: Date): void {
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
		throw new RangeError('Report dates must be valid');
	}
	if (to.getTime() <= from.getTime()) throw new RangeError('Report to date must be after from date');
}

export function chooseReportBucket(from: Date, to: Date, requested: RequestedReportBucket = 'Auto'): ReportBucket {
	assertValidRange(from, to);
	if (requested !== 'Auto') return requested;
	const rangeMilliseconds = to.getTime() - from.getTime();
	if (rangeMilliseconds <= 30 * DAY_MILLISECONDS) return 'Day';
	if (rangeMilliseconds <= 366 * DAY_MILLISECONDS) return 'Week';
	return 'Month';
}

function localDateOrdinal(date: LocalDate): number {
	const value = new Date(0);
	value.setUTCFullYear(date.year, date.month - 1, date.day);
	value.setUTCHours(0, 0, 0, 0);
	return value.getTime();
}

function localDateFromOrdinal(ordinal: number): LocalDate {
	const value = new Date(ordinal);
	return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function createLocalDateReader(timeZone: string): (date: Date) => LocalDate {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return (date) => {
		const fields = new Map(
			formatter
				.formatToParts(date)
				.filter((part) => part.type !== 'literal')
				.map((part) => [part.type, Number(part.value)]),
		);
		const year = fields.get('year');
		const month = fields.get('month');
		const day = fields.get('day');
		if (year == null || month == null || day == null) throw new RangeError('Unable to read local report date');
		return { year, month, day };
	};
}

function getBucketLocalStart(localDate: LocalDate, bucket: ReportBucket): LocalDate {
	if (bucket === 'Day') return localDate;
	if (bucket === 'Month') return { ...localDate, day: 1 };
	const ordinal = localDateOrdinal(localDate);
	const dayOfWeek = new Date(ordinal).getUTCDay();
	const daysSinceMonday = (dayOfWeek + 6) % 7;
	return localDateFromOrdinal(ordinal - daysSinceMonday * DAY_MILLISECONDS);
}

function getNextBucketLocalStart(localDate: LocalDate, bucket: ReportBucket): LocalDate {
	if (bucket === 'Month') {
		return localDate.month === 12
			? { year: localDate.year + 1, month: 1, day: 1 }
			: { year: localDate.year, month: localDate.month + 1, day: 1 };
	}
	const dayCount = bucket === 'Day' ? 1 : 7;
	return localDateFromOrdinal(localDateOrdinal(localDate) + dayCount * DAY_MILLISECONDS);
}

function findLocalDateStart(localDate: LocalDate, readLocalDate: (date: Date) => LocalDate): Date {
	const targetOrdinal = localDateOrdinal(localDate);
	let low = targetOrdinal - DATE_BOUNDARY_SEARCH_HOURS * 60 * 60 * 1000;
	let high = targetOrdinal + DATE_BOUNDARY_SEARCH_HOURS * 60 * 60 * 1000;
	while (localDateOrdinal(readLocalDate(new Date(low))) >= targetOrdinal) low -= DAY_MILLISECONDS;
	while (localDateOrdinal(readLocalDate(new Date(high))) < targetOrdinal) high += DAY_MILLISECONDS;

	while (high - low > 1) {
		const middle = low + Math.floor((high - low) / 2);
		if (localDateOrdinal(readLocalDate(new Date(middle))) >= targetOrdinal) high = middle;
		else low = middle;
	}
	return new Date(high);
}

function createHistoryBuckets(
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
function recordHistoryCounts(
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

function markMetricPartial(history: readonly MutableHistoryAggregate[], metricName: AggregateMetricName): void {
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
function addPendingRevenueHistory(
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

function addCohortHistory(
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

function addSellerRevenueHistory(
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

function addBuyerRevenueHistory(
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

function walletGroupKey(row: ReportRow): string {
	return `${row.managedWallet == null ? 'unassigned' : `wallet:${row.managedWallet.id}`}:${row.role}`;
}

function buildWalletAggregates(
	rows: readonly ReportRow[],
	fees: FeeAnalysis,
	dateBasis: ReportDateBasis,
	from: Date,
	to: Date,
	checkpoint: ReportCheckpoint,
): ReportWalletAggregate[] {
	const groupedRows = new Map<string, { managedWallet: ReportRow['managedWallet']; rows: ReportRow[] }>();
	for (const [index, row] of rows.entries()) {
		runReportCheckpoint(index, checkpoint);
		const key = walletGroupKey(row);
		const group = groupedRows.get(key) ?? { managedWallet: row.managedWallet, rows: [] };
		group.rows.push(row);
		groupedRows.set(key, group);
	}
	const metricsByGroup = new Map<string, ReportAggregate>();
	let groupIndex = 0;
	for (const [key, group] of groupedRows) {
		runReportCheckpoint(groupIndex, checkpoint);
		groupIndex += 1;
		const metrics = createAggregate();
		for (const [index, row] of group.rows.entries()) {
			runReportCheckpoint(index, checkpoint);
			addRoleMetrics(metrics, row);
			addPendingRevenue(metrics, row);
		}
		Object.assign(metrics, getReportTransactionCount(group.rows, dateBasis, from, to));
		metricsByGroup.set(key, metrics);
	}
	const rowsByPayment = groupReportRowsByPayment(rows, checkpoint);
	const groupsByPayment = new Map<string, string[]>();
	let paymentIndex = 0;
	for (const [paymentKey, paymentRows] of rowsByPayment) {
		runReportCheckpoint(paymentIndex, checkpoint);
		paymentIndex += 1;
		const groups = Array.from(new Set(paymentRows.map(walletGroupKey))).sort((left, right) =>
			left.localeCompare(right),
		);
		groupsByPayment.set(paymentKey, groups);
	}
	for (const [index, component] of fees.components.entries()) {
		runReportCheckpoint(index, checkpoint);
		const componentGroups = Array.from(new Set(component.paymentKeys.flatMap((key) => groupsByPayment.get(key)!)));
		const ownerGroups = Array.from(
			new Set(
				component.paymentKeys.flatMap((key) =>
					(rowsByPayment.get(key) ?? []).filter((row) => row.isFeeReconciliationOwner).map(walletGroupKey),
				),
			),
		);
		if (ownerGroups.length !== 1) {
			for (const group of componentGroups) {
				metricsByGroup.get(group)!.actorCardanoFees.completeness = 'partial';
				metricsByGroup.get(group)!.adminCardanoFees.completeness = 'partial';
				metricsByGroup.get(group)!.totalCardanoFees.completeness = 'partial';
			}
			continue;
		}
		const metrics = metricsByGroup.get(ownerGroups[0])!;
		addMetric(
			metrics.actorCardanoFees,
			component.actorFees === 0n ? [] : [{ unit: 'lovelace', amount: component.actorFees }],
			component.isActorComplete ? 'complete' : 'partial',
		);
		addMetric(
			metrics.adminCardanoFees,
			component.admin == null ? null : [{ unit: 'lovelace', amount: component.admin }],
			component.isAdminComplete ? 'complete' : 'partial',
		);
		addMetric(
			metrics.totalCardanoFees,
			component.total === 0n ? [] : [{ unit: 'lovelace', amount: component.total }],
			component.isTotalComplete ? 'complete' : 'partial',
		);
	}
	if (fees.actorCompleteness === 'partial') {
		for (const metrics of metricsByGroup.values()) metrics.actorCardanoFees.completeness = 'partial';
	}
	if (fees.totalCompleteness === 'partial') {
		for (const metrics of metricsByGroup.values()) metrics.totalCardanoFees.completeness = 'partial';
	}
	if (fees.adminCompleteness === 'partial') {
		for (const metrics of metricsByGroup.values()) metrics.adminCardanoFees.completeness = 'partial';
	}
	return Array.from(groupedRows)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, group], index) => {
			runReportCheckpoint(index, checkpoint);
			return {
				managedWallet: group.managedWallet,
				role: group.rows[0].role,
				metrics: metricsByGroup.get(key)!,
			};
		});
}

function addFeeHistory(
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

export function aggregateReportRows(
	rows: readonly ReportRow[],
	requestedBucket: RequestedReportBucket,
	timeZone: string,
	from: Date,
	to: Date,
	dateBasis: ReportDateBasis,
	checkpoint: ReportCheckpoint = NO_REPORT_CHECKPOINT,
): ReportAggregateResult {
	rows = assignCompleteReportFeeReconciliation(rows, dateBasis, from, to, checkpoint);
	checkpoint();
	const bucket = chooseReportBucket(from, to, requestedBucket);
	const readLocalDate = createLocalDateReader(timeZone);
	const mutableHistory = createHistoryBuckets(from, to, bucket, readLocalDate, checkpoint);
	const historyByStart = new Map(mutableHistory.map((entry) => [entry.bucketStart.getTime(), entry]));
	const missingTimestampMetrics = new Set<AggregateMetricName>();
	for (const [index, row] of rows.entries()) {
		runReportCheckpoint(index, checkpoint);
		if (dateBasis === 'RevenueRecognizedAt') {
			addSellerRevenueHistory(row, from, to, bucket, readLocalDate, historyByStart, missingTimestampMetrics);
			addBuyerRevenueHistory(row, from, to, bucket, readLocalDate, historyByStart, missingTimestampMetrics);
		} else {
			addCohortHistory(row, dateBasis, from, to, bucket, readLocalDate, historyByStart, missingTimestampMetrics);
		}
		addPendingRevenueHistory(row, from, to, bucket, readLocalDate, historyByStart);
	}
	recordHistoryCounts(rows, dateBasis, from, to, bucket, readLocalDate, historyByStart);
	const global = aggregateGlobalRows(rows, dateBasis, from, to, checkpoint);
	const totals = global.metrics;
	const isFeeHistoryComplete = addFeeHistory(
		rows,
		dateBasis,
		global.fees,
		from,
		to,
		bucket,
		readLocalDate,
		historyByStart,
		mutableHistory,
		checkpoint,
	);
	for (const metricName of missingTimestampMetrics) markMetricPartial(mutableHistory, metricName);
	if (totals.transactionCountCompleteness === 'partial') {
		for (const entry of mutableHistory) entry.metrics.transactionCountCompleteness = 'partial';
	}

	const warnings: ReportWarning[] = [];
	const hasActorFeeAllocation = rows.some((row) => row.actorCardanoFeeAllocation.completeness === 'partial');
	if (hasActorFeeAllocation) {
		warnings.push({
			code: 'HISTORY_ACTOR_CARDANO_FEE_ALLOCATION_PARTIAL',
			message:
				'Stored actor Cardano fees use an accounting event for history because their exact transaction time is unavailable.',
			rowId: null,
		});
	}
	if (totals.transactionCountCompleteness === 'partial') {
		warnings.push({
			code: 'TRANSACTION_COUNT_PARTIAL',
			message:
				'One or more logical payments lack the accounting time needed to prove date-range membership. Distinct counts are partial.',
			rowId: null,
		});
	}
	if (
		totals.actorCardanoFees.completeness === 'partial' ||
		totals.totalCardanoFees.completeness === 'partial' ||
		totals.adminCardanoFees.completeness === 'partial'
	) {
		warnings.push({
			code: 'CARDANO_FEE_COVERAGE_PARTIAL',
			message:
				'Transaction evidence, filtered related requests, or actor fee timing prevents an exact Cardano fee reconciliation.',
			rowId: null,
		});
	}
	if (!isFeeHistoryComplete) {
		warnings.push({
			code: 'HISTORY_CARDANO_FEE_ALLOCATION_PARTIAL',
			message: 'Related logical payments do not resolve to one exact fee history bucket.',
			rowId: null,
		});
	}
	if (missingTimestampMetrics.size > 0) {
		warnings.push({
			code: 'HISTORY_ECONOMIC_TIMESTAMP_MISSING',
			message: 'One or more economic amounts lack the confirmed chain time required for an exact history bucket.',
			rowId: null,
		});
	}

	const wallets = buildWalletAggregates(rows, global.fees, dateBasis, from, to, checkpoint);
	finalizeAggregate(totals);
	for (const [index, wallet] of wallets.entries()) {
		runReportCheckpoint(index, checkpoint);
		finalizeAggregate(wallet.metrics);
	}
	for (const [index, entry] of mutableHistory.entries()) {
		runReportCheckpoint(index, checkpoint);
		finalizeAggregate(entry.metrics);
	}

	return {
		totals,
		wallets,
		history: mutableHistory.map(({ transactionKeys: _transactionKeys, ...entry }) => entry),
		bucket,
		warnings,
		historyFeeCompleteness:
			!isFeeHistoryComplete ||
			hasActorFeeAllocation ||
			totals.actorCardanoFees.completeness === 'partial' ||
			totals.totalCardanoFees.completeness === 'partial' ||
			totals.adminCardanoFees.completeness === 'partial'
				? 'partial'
				: 'complete',
	};
}
