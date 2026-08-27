import { useMemo } from 'react';
import {
  getReportAssetDescriptor,
  type ReportMetricKey,
  type ReportSummary,
} from '@/lib/transaction-report/dashboard-metrics';
import { buildReportChartRows } from '@/lib/transaction-report/chart-data';
import { ReportChart, ReportChartLegend, type ReportChartSeries } from './ReportChart';
import { ReportHistoryTable } from './ReportHistoryTable';
import { ReportMetricTile } from './ReportMetricTile';

/**
 * One detail tab: the figures for a period, the same figures over time, and
 * the exact numbers on request. Revenue, spending, and fees all use it, so the
 * three tabs stay identical in shape and only their series differ.
 */
export function ReportSeriesTab({
  summary,
  unit,
  metricKeys,
  series,
  title,
  description,
  accents,
  emptyMessage,
}: Readonly<{
  summary: ReportSummary;
  unit: string;
  metricKeys: readonly ReportMetricKey[];
  series: readonly ReportChartSeries[];
  title: string;
  description: string;
  accents?: Readonly<Partial<Record<ReportMetricKey, string>>>;
  emptyMessage?: string;
}>) {
  const descriptor = getReportAssetDescriptor(summary, unit);
  const rows = useMemo(
    () =>
      buildReportChartRows(
        summary,
        unit,
        series.map((entry) => entry.key),
        descriptor,
      ),
    [descriptor, series, summary, unit],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metricKeys.map((metricKey) => (
          <ReportMetricTile
            key={metricKey}
            metricKey={metricKey}
            metrics={summary.totals}
            descriptor={descriptor}
            accentColor={accents?.[metricKey]}
          />
        ))}
      </div>

      <div className="rounded-lg border p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-medium">{title}</div>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <ReportChartLegend series={series} />
        </div>
        <ReportChart rows={rows} series={series} emptyMessage={emptyMessage} />
        <ReportHistoryTable rows={rows} series={series} label={title} />
      </div>
    </div>
  );
}
