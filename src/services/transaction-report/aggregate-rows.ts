/**
 * Folding report rows into one aggregate.
 *
 * This module owns the period totals: how a single row contributes to each
 * metric, and how a metric's completeness follows from the rows behind it. The
 * daily, weekly and monthly split lives in `aggregate-history.ts`.
 */
import type { AtomicAmount } from './amounts';
import { addAggregateMetric as addMetric, createAggregateMetric as createMetric } from './aggregate-amounts';
import { getReportTransactionCount } from './aggregate-counts';
import { analyzeReportFees, type FeeAnalysis } from './aggregate-fees';
import type { ReportAggregate, ReportDateBasis, ReportMetricCompleteness } from './aggregate-types';
import type { ReportRow } from './records';
import { runReportCheckpoint, type ReportCheckpoint } from './checkpoint';

export function createAggregate(): ReportAggregate {
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
export function hasAmounts(amounts: readonly AtomicAmount[] | null): boolean {
	return amounts != null && amounts.some((amount) => amount.amount !== 0n);
}

export function isProtocolMetricComplete(row: ReportRow): boolean {
	return row.seller?.protocolFee.completeness === 'exact' || row.seller?.protocolFee.completeness === 'not_applicable';
}

export function combineCompleteness(...values: ReportMetricCompleteness[]): ReportMetricCompleteness {
	return values.every((value) => value === 'complete') ? 'complete' : 'partial';
}

/**
 * Money locked in escrow that the seller has not earned yet.
 *
 * It is kept out of the role metrics on purpose: it is not revenue, and a
 * cohort history must not place it on an accounting date it does not have.
 */
export function addPendingRevenue(aggregate: ReportAggregate, row: ReportRow): void {
	if (row.seller == null) return;
	addMetric(aggregate.sellerPendingRevenue, row.pendingRevenue);
}

export function addRoleMetrics(aggregate: ReportAggregate, row: ReportRow): void {
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

export function aggregateGlobalRows(
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
