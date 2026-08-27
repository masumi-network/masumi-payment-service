/**
 * Turning report rows into the aggregate a report renders.
 *
 * This module is the entry point. It runs the parts in order: reconcile fees,
 * choose a bucket, fill the history, fold the period totals, group the wallets,
 * then collect the warnings that tell the reader which numbers are partial.
 * The parts themselves live in the sibling `aggregate-*.ts` modules.
 */
import { assignCompleteReportFeeReconciliation } from './aggregate-fees';
import { chooseReportBucket, createLocalDateReader } from './aggregate-calendar';
import {
	addBuyerRevenueHistory,
	addCohortHistory,
	addFeeHistory,
	addPendingRevenueHistory,
	addSellerRevenueHistory,
	createHistoryBuckets,
	markMetricPartial,
	recordHistoryCounts,
} from './aggregate-history';
import { aggregateGlobalRows } from './aggregate-rows';
import { buildWalletAggregates } from './aggregate-wallets';
import { finalizeReportAggregate as finalizeAggregate } from './aggregate-amounts';
import type {
	AggregateMetricName,
	ReportAggregateResult,
	ReportDateBasis,
	RequestedReportBucket,
} from './aggregate-types';
import type { ReportRow, ReportWarning } from './records';
import { NO_REPORT_CHECKPOINT, runReportCheckpoint, type ReportCheckpoint } from './checkpoint';

export type {
	ReportAggregate,
	ReportAggregateMetric,
	ReportAggregateResult,
	ReportBucket,
	ReportDateBasis,
	ReportHistoryAggregate,
	ReportMetricCompleteness,
	ReportWalletAggregate,
	RequestedReportBucket,
} from './aggregate-types';
export { chooseReportBucket } from './aggregate-calendar';
export { serializeReportAggregateResult } from './aggregate-serialization';

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
