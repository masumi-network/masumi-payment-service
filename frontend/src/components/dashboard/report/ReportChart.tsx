import { useId, type ReactNode } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/utils';
import { InfoHint } from '@/components/ui/info-hint';
import type { ReportMetricKey } from '@/lib/transaction-report/dashboard-metrics';
import {
  decimateReportChartRows,
  formatReportAxisValue,
  REPORT_CHART_BUCKET_LIMIT,
  type ReportChartRow,
} from '@/lib/transaction-report/chart-data';

export type ReportChartSeries = Readonly<{
  key: ReportMetricKey;
  label: string;
  color: string;
  /** `area` fills to the axis and reads as a headline. `line` overlays on top. */
  kind?: 'area' | 'line';
  dashed?: boolean;
  /** Shown behind an info icon in the legend, for a series that needs one. */
  hint?: ReactNode;
}>;

type ReportChartProps = Readonly<{
  rows: readonly ReportChartRow[];
  series: readonly ReportChartSeries[];
  height?: number;
  emptyMessage?: string;
}>;

type TooltipPayloadEntry = Readonly<{ payload?: ReportChartRow }>;

function ChartTooltip({
  active,
  payload,
  series,
}: Readonly<{
  active?: boolean;
  payload?: readonly TooltipPayloadEntry[];
  series: readonly ReportChartSeries[];
}>) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <div className="mb-1.5 text-xs font-medium">{row.bucketTitle}</div>
      <div className="space-y-1">
        {series.map((entry) => (
          <div key={entry.key} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span className="text-muted-foreground">{entry.label}</span>
            <span className="ml-auto font-mono tabular-nums">
              {row[entry.key] == null ? 'Not known' : (row.bucketTexts[entry.key] ?? '—')}
            </span>
          </div>
        ))}
      </div>
      {row.bucketPartial && (
        <div className="mt-1.5 text-[11px] text-muted-foreground">Some values are estimates.</div>
      )}
    </div>
  );
}

export function ReportChartLegend({ series }: Readonly<{ series: readonly ReportChartSeries[] }>) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {series.map((entry) => (
        <span key={entry.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn(
              'w-4 rounded-full',
              (entry.kind ?? 'line') === 'area' ? 'h-2 opacity-45' : 'h-0.5',
            )}
            style={{
              backgroundColor: entry.color,
              backgroundImage: entry.dashed
                ? `repeating-linear-gradient(90deg, ${entry.color} 0 4px, transparent 4px 7px)`
                : undefined,
            }}
          />
          {entry.label}
          {entry.hint && <InfoHint label={entry.label.toLowerCase()}>{entry.hint}</InfoHint>}
        </span>
      ))}
    </div>
  );
}

const REPORT_CHART_DOT_LIMIT = 45;

export function ReportChart({
  rows,
  series,
  height = 264,
  emptyMessage = 'No activity in this period.',
}: ReportChartProps) {
  const gradientId = useId();

  // A bucket set where every plotted value is unknown paints an empty grid,
  // which reads as a broken chart rather than as missing data.
  const hasPlottableValue = rows.some((row) => series.some((entry) => row[entry.key] != null));

  if (rows.length === 0 || !hasPlottableValue) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        {emptyMessage}
      </div>
    );
  }

  const visibleRows = decimateReportChartRows(rows);
  // Sparse buckets read as a curve of invented activity without a marker on
  // each real reading.
  const showDots = visibleRows.length <= REPORT_CHART_DOT_LIMIT;
  const areaSeries = series.filter((entry) => (entry.kind ?? 'line') === 'area');
  const lineSeries = series.filter((entry) => (entry.kind ?? 'line') === 'line');

  return (
    <div className="text-muted-foreground">
      {/* ResponsiveContainer draws nothing until it has measured, so the server
          render and the first client render already agree. */}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={visibleRows as ReportChartRow[]} margin={{ top: 8, right: 8 }}>
          <defs>
            {areaSeries.map((entry) => (
              <linearGradient
                key={entry.key}
                id={`${gradientId}-${entry.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={entry.color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={entry.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid
            vertical={false}
            strokeDasharray="3 3"
            stroke="currentColor"
            strokeOpacity={0.18}
          />
          <XAxis
            dataKey="bucketLabel"
            tickLine={false}
            axisLine={false}
            minTickGap={28}
            tick={{ fill: 'currentColor', fontSize: 11 }}
          />
          <YAxis
            width={64}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatReportAxisValue}
            tick={{ fill: 'currentColor', fontSize: 11 }}
          />
          <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.35} />
          <Tooltip
            cursor={{ stroke: 'currentColor', strokeOpacity: 0.25, strokeWidth: 1 }}
            content={<ChartTooltip series={series} />}
          />
          {areaSeries.map((entry) => (
            <Area
              key={entry.key}
              type="linear"
              dataKey={entry.key}
              stroke={entry.color}
              strokeWidth={2}
              fill={`url(#${gradientId}-${entry.key})`}
              dot={showDots ? { r: 2, strokeWidth: 0, fill: entry.color } : false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
          {lineSeries.map((entry) => (
            <Line
              key={entry.key}
              type="linear"
              dataKey={entry.key}
              stroke={entry.color}
              strokeWidth={2}
              strokeDasharray={entry.dashed ? '5 4' : undefined}
              dot={showDots ? { r: 2, strokeWidth: 0, fill: entry.color } : false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      {rows.length > REPORT_CHART_BUCKET_LIMIT && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          The chart samples this long period. Exports keep every day.
        </p>
      )}
    </div>
  );
}
