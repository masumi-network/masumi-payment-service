/**
 * The shape of a report aggregate, shared by every `aggregate-*` module.
 *
 * These types sit in their own file so the modules that build an aggregate and
 * the modules that read one can both import them without importing each other.
 */
import type { AtomicAmount } from './amounts';
import type { ReportMetricWindow, ReportRow, ReportWarning } from './records';

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

export type AggregateMetricName = Exclude<keyof ReportAggregate, 'transactionCount' | 'transactionCountCompleteness'>;
export type ReportDateBasis = ReportMetricWindow['dateBasis'];
