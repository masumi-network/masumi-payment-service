import {
  formatReportMetricValue,
  getReportAssetDescriptor,
  getReportMetricAmount,
  type ReportAssetDescriptor,
  type ReportMetricKey,
  type ReportSummary,
} from './dashboard-metrics';

/**
 * Recharts plots numbers, so every bucket carries a `number` per series for the
 * geometry and the already-formatted exact string for the tooltip. The number
 * is display-only. Ledger values stay in the raw BigInt strings the API sends.
 */
export type ReportChartRow = Readonly<{
  bucketLabel: string;
  bucketTitle: string;
  bucketPartial: boolean;
  bucketTexts: Readonly<Partial<Record<ReportMetricKey, string>>>;
}> &
  Readonly<Partial<Record<ReportMetricKey, number | null>>>;

/** Beyond this, a chart draws more points than a screen has pixels. */
export const REPORT_CHART_BUCKET_LIMIT = 180;

export function toReportChartValue(
  rawAmount: string | null | undefined,
  decimalAmount: string | null | undefined,
  decimals: number | null | undefined,
): number | null {
  if (decimalAmount != null) {
    const decimalValue = Number(decimalAmount);
    return Number.isFinite(decimalValue) ? decimalValue : null;
  }
  if (rawAmount == null) return null;
  const rawValue = Number(rawAmount);
  if (!Number.isFinite(rawValue)) return null;
  return decimals == null || decimals <= 0 ? rawValue : rawValue / 10 ** decimals;
}

function formatBucketLabel(
  bucketStart: Date,
  timeZone: string,
  bucket: ReportSummary['bucket'],
): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: 'short',
    ...(bucket === 'Month' ? { year: 'numeric' as const } : { day: 'numeric' as const }),
  }).format(bucketStart);
}

function formatBucketTitle(bucketStart: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: 'medium',
  }).format(bucketStart);
}

export function buildReportChartRows(
  summary: ReportSummary,
  unit: string,
  metricKeys: readonly ReportMetricKey[],
  descriptor: ReportAssetDescriptor = getReportAssetDescriptor(summary, unit),
): ReportChartRow[] {
  const timeZone = summary.metadata.filters.timeZone;

  return summary.history.map((bucket) => {
    const values: Partial<Record<ReportMetricKey, number | null>> = {};
    const texts: Partial<Record<ReportMetricKey, string>> = {};
    let isPartial = false;

    for (const metricKey of metricKeys) {
      const metric = bucket.metrics[metricKey];
      const amount = getReportMetricAmount(bucket.metrics, metricKey, unit);
      // A partial bucket with no amount is genuinely unknown, not zero, so the
      // line breaks there instead of dipping to the axis and inventing a dip.
      const isUnknown = metric.completeness === 'partial' && amount == null;
      values[metricKey] = isUnknown
        ? null
        : (toReportChartValue(amount?.rawAmount, amount?.decimalAmount, amount?.decimals) ?? 0);
      texts[metricKey] = formatReportMetricValue(metric, unit, descriptor).text;
      if (metric.completeness === 'partial') isPartial = true;
    }

    return {
      ...values,
      bucketLabel: formatBucketLabel(bucket.bucketStart, timeZone, summary.bucket),
      bucketTitle: formatBucketTitle(bucket.bucketStart, timeZone),
      bucketPartial: isPartial,
      bucketTexts: texts,
    };
  });
}

/**
 * Evenly samples a long history down to `limit` buckets, always keeping the
 * first and last so the period still starts and ends where the filter says.
 */
export function decimateReportChartRows(
  rows: readonly ReportChartRow[],
  limit = REPORT_CHART_BUCKET_LIMIT,
): readonly ReportChartRow[] {
  const maximum = Math.max(2, Math.floor(limit));
  if (rows.length <= maximum) return rows;

  const sampled: ReportChartRow[] = [];
  const step = (rows.length - 1) / (maximum - 1);
  for (let index = 0; index < maximum; index += 1) {
    sampled.push(rows[Math.round(index * step)]);
  }
  return sampled;
}

/** Axis ticks stay narrow: 1234567 reads as `1.23M`, 1200 as `1.2k`. */
export function formatReportAxisValue(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (magnitude >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (magnitude === 0) return '0';
  if (magnitude < 1) return value.toFixed(2);
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
