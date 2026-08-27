import { serializeReportAmount } from '@/utils/asset-units';
import type { ReportAggregate, ReportAggregateMetric, ReportAggregateResult } from './aggregate';

function serializeAggregateMetric(metric: ReportAggregateMetric) {
	return { amounts: metric.amounts.map(serializeReportAmount), completeness: metric.completeness };
}

function serializeAggregate(aggregate: ReportAggregate) {
	return {
		transactionCount: aggregate.transactionCount,
		transactionCountCompleteness: aggregate.transactionCountCompleteness,
		sellerGrossRevenue: serializeAggregateMetric(aggregate.sellerGrossRevenue),
		sellerPendingRevenue: serializeAggregateMetric(aggregate.sellerPendingRevenue),
		protocolFees: serializeAggregateMetric(aggregate.protocolFees),
		sellerCardanoFees: serializeAggregateMetric(aggregate.sellerCardanoFees),
		actorCardanoFees: serializeAggregateMetric(aggregate.actorCardanoFees),
		adminCardanoFees: serializeAggregateMetric(aggregate.adminCardanoFees),
		totalCardanoFees: serializeAggregateMetric(aggregate.totalCardanoFees),
		sellerNetRevenue: serializeAggregateMetric(aggregate.sellerNetRevenue),
		buyerGrossSpend: serializeAggregateMetric(aggregate.buyerGrossSpend),
		returnedFunds: serializeAggregateMetric(aggregate.returnedFunds),
		buyerCardanoFees: serializeAggregateMetric(aggregate.buyerCardanoFees),
		buyerNetSpend: serializeAggregateMetric(aggregate.buyerNetSpend),
	};
}

export function serializeReportAggregateResult(result: ReportAggregateResult) {
	return {
		totals: serializeAggregate(result.totals),
		wallets: result.wallets.map((wallet) => ({
			managedWallet: wallet.managedWallet,
			role: wallet.role,
			metrics: serializeAggregate(wallet.metrics),
		})),
		history: result.history.map((entry) => ({
			bucketStart: entry.bucketStart,
			bucketEnd: entry.bucketEnd,
			metrics: serializeAggregate(entry.metrics),
		})),
		bucket: result.bucket,
		warnings: result.warnings,
		historyFeeCompleteness: result.historyFeeCompleteness,
	};
}
