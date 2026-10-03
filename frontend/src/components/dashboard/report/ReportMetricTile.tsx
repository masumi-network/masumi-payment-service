import { cn } from '@/lib/utils';
import {
  formatReportMetricValue,
  getEmptyReportAssetLabel,
  type ReportAssetDescriptor,
  type ReportMetric,
  type ReportMetricKey,
  type ReportMetrics,
} from '@/lib/transaction-report/dashboard-metrics';
import { REPORT_METRIC_HINTS, REPORT_METRIC_LABELS } from '@/lib/transaction-report/report-labels';
import { EstimateDot } from './ReportCompleteness';

/** Keeps only the amount for the currency on screen, so a tile shows one number. */
export function scopeMetricToUnit(
  metrics: ReportMetrics,
  metricKey: ReportMetricKey,
  unit: string | null,
): ReportMetric {
  const metric = metrics[metricKey];
  if (unit == null) return { ...metric, amounts: [] };
  const amount = metric.amounts.find((candidate) => candidate.unit === unit);
  return { ...metric, amounts: amount ? [amount] : [] };
}

export function ReportMetricValue({
  metric,
  descriptor,
  className,
}: Readonly<{
  metric: ReportMetric;
  descriptor: ReportAssetDescriptor | null;
  className?: string;
}>) {
  if (!descriptor) {
    return (
      <span className={cn('text-muted-foreground', className)}>
        {getEmptyReportAssetLabel(metric.completeness)}
      </span>
    );
  }

  const display = formatReportMetricValue(metric, descriptor.unit, descriptor);
  if (display.isUnknown) {
    return <span className={cn('text-muted-foreground', className)}>{display.text}</span>;
  }

  // The number and its ticker wrap as two units. Breaking inside the digits
  // makes an amount unreadable, which is exactly what a narrow card invites.
  return (
    <span className={cn('inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0', className)}>
      <span className="font-mono tabular-nums">{display.value}</span>
      <span className="text-xs font-normal text-muted-foreground">{display.unitLabel}</span>
      {display.isPartial && <EstimateDot />}
    </span>
  );
}

/**
 * A compact figure inside a detail tab. Matches the app's plain
 * `border rounded-lg` block rather than a shadowed card, and carries an accent
 * stripe like the dashboard stat cards do.
 */
export function ReportMetricTile({
  metricKey,
  metrics,
  descriptor,
  accentColor,
  showHint = true,
}: Readonly<{
  metricKey: ReportMetricKey;
  metrics: ReportMetrics;
  descriptor: ReportAssetDescriptor | null;
  accentColor?: string;
  showHint?: boolean;
}>) {
  const metric = scopeMetricToUnit(metrics, metricKey, descriptor?.unit ?? null);

  return (
    <div
      className="rounded-lg border p-4"
      style={accentColor ? { borderLeftWidth: '3px', borderLeftColor: accentColor } : undefined}
    >
      <div className="text-xs text-muted-foreground">{REPORT_METRIC_LABELS[metricKey]}</div>
      <ReportMetricValue
        metric={metric}
        descriptor={descriptor}
        className="mt-1.5 text-base font-semibold"
      />
      {showHint && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {REPORT_METRIC_HINTS[metricKey]}
        </div>
      )}
    </div>
  );
}
