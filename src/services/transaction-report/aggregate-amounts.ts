import {
	accumulateAmounts,
	createAmountAccumulator,
	materializeAmounts,
	type AmountAccumulator,
	type AtomicAmount,
} from './amounts';
import type { ReportAggregate, ReportAggregateMetric, ReportMetricCompleteness } from './aggregate-types';

const metricAmounts = new WeakMap<ReportAggregateMetric, AmountAccumulator>();

function getMetricAccumulator(metric: ReportAggregateMetric): AmountAccumulator {
	const existing = metricAmounts.get(metric);
	if (existing != null) return existing;
	const accumulator = createAmountAccumulator();
	accumulateAmounts(accumulator, metric.amounts);
	metricAmounts.set(metric, accumulator);
	return accumulator;
}

export function createAggregateMetric(): ReportAggregateMetric {
	const metric = { amounts: [], completeness: 'complete' } satisfies ReportAggregateMetric;
	metricAmounts.set(metric, createAmountAccumulator());
	return metric;
}

export function addAggregateMetric(
	metric: ReportAggregateMetric,
	amounts: readonly AtomicAmount[] | null,
	completeness: ReportMetricCompleteness = 'complete',
): void {
	if (amounts != null) accumulateAmounts(getMetricAccumulator(metric), amounts);
	if (amounts == null || completeness === 'partial') metric.completeness = 'partial';
}

export function readAggregateMetricAmounts(metric: ReportAggregateMetric): AtomicAmount[] {
	return materializeAmounts(getMetricAccumulator(metric));
}

export function finalizeReportAggregate(aggregate: ReportAggregate): void {
	for (const value of Object.values(aggregate)) {
		if (typeof value === 'object' && value != null && metricAmounts.has(value)) {
			value.amounts = readAggregateMetricAmounts(value);
		}
	}
}
