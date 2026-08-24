import { useMemo, useState } from 'react';
import type { PostReportsSummaryResponses } from '@/lib/api/generated';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  buildReportChartPoints,
  buildReportLinePath,
  getReportAssetDescriptor,
  getReportChartDomain,
  scaleReportChartY,
  type ReportChartPoint,
  type ReportMetricKey,
} from '@/lib/transaction-report/dashboard-metrics';
import {
  decimateReportChartPoints,
  paginateReportRows,
  REPORT_CHART_POINT_LIMIT,
  resetReportTablePageState,
  type ReportTablePageState,
} from '@/lib/transaction-report/report-rendering';
import { ReportTablePagination } from './ReportTablePagination';

type ReportSummary = PostReportsSummaryResponses[200]['data'];
type ReportRole = ReportSummary['wallets'][number]['role'];

type ChartSeries = Readonly<{
  key: ReportMetricKey;
  label: string;
  className: string;
  fillClassName: string;
  dash?: string;
  marker: 'circle' | 'square' | 'diamond';
}>;

const CHART_DIMENSIONS = { width: 640, height: 240, padding: 24 } as const;

const SELLER_VALUE_SERIES: readonly ChartSeries[] = [
  {
    key: 'sellerGrossRevenue',
    label: 'Gross revenue',
    className: 'stroke-emerald-600 dark:stroke-emerald-400',
    fillClassName: 'fill-emerald-600 dark:fill-emerald-400',
    marker: 'circle',
  },
  {
    key: 'protocolFees',
    label: 'Protocol fees',
    className: 'stroke-amber-600 dark:stroke-amber-400',
    fillClassName: 'fill-amber-600 dark:fill-amber-400',
    dash: '8 5',
    marker: 'square',
  },
  {
    key: 'sellerNetRevenue',
    label: 'Net revenue',
    className: 'stroke-teal-700 dark:stroke-teal-300',
    fillClassName: 'fill-teal-700 dark:fill-teal-300',
    dash: '2 4',
    marker: 'diamond',
  },
];

const BUYER_VALUE_SERIES: readonly ChartSeries[] = [
  {
    key: 'buyerGrossSpend',
    label: 'Gross spend',
    className: 'stroke-blue-600 dark:stroke-blue-400',
    fillClassName: 'fill-blue-600 dark:fill-blue-400',
    dash: '12 3',
    marker: 'circle',
  },
  {
    key: 'returnedFunds',
    label: 'Returned funds',
    className: 'stroke-violet-600 dark:stroke-violet-400',
    fillClassName: 'fill-violet-600 dark:fill-violet-400',
    dash: '6 2 1 2',
    marker: 'square',
  },
  {
    key: 'buyerNetSpend',
    label: 'Net spend',
    className: 'stroke-cyan-700 dark:stroke-cyan-300',
    fillClassName: 'fill-cyan-700 dark:fill-cyan-300',
    dash: '1 3',
    marker: 'diamond',
  },
];

const CARDANO_FEE_SERIES: readonly ChartSeries[] = [
  {
    key: 'sellerCardanoFees',
    label: 'Seller fees',
    className: 'stroke-emerald-600 dark:stroke-emerald-400',
    fillClassName: 'fill-emerald-600 dark:fill-emerald-400',
    marker: 'circle',
  },
  {
    key: 'buyerCardanoFees',
    label: 'Buyer fees',
    className: 'stroke-blue-600 dark:stroke-blue-400',
    fillClassName: 'fill-blue-600 dark:fill-blue-400',
    dash: '8 5',
    marker: 'square',
  },
  {
    key: 'actorCardanoFees',
    label: 'Reconciled actor fees',
    className: 'stroke-rose-600 dark:stroke-rose-400',
    fillClassName: 'fill-rose-600 dark:fill-rose-400',
    dash: '10 2 2 2',
    marker: 'square',
  },
  {
    key: 'adminCardanoFees',
    label: 'Admin fees',
    className: 'stroke-amber-600 dark:stroke-amber-400',
    fillClassName: 'fill-amber-600 dark:fill-amber-400',
    dash: '2 4',
    marker: 'diamond',
  },
  {
    key: 'totalCardanoFees',
    label: 'Total fees',
    className: 'stroke-violet-600 dark:stroke-violet-400',
    fillClassName: 'fill-violet-600 dark:fill-violet-400',
    dash: '12 4 2 4',
    marker: 'circle',
  },
];

function formatBucket(date: Date, timeZone: string, bucket: ReportSummary['bucket']): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: 'numeric',
    month: bucket === 'Month' ? 'short' : 'short',
    ...(bucket === 'Month' ? {} : { day: 'numeric' as const }),
  }).format(date);
}

function SeriesMarker({
  point,
  series,
}: Readonly<{ point: ReportChartPoint; series: ChartSeries }>) {
  const fillClass = point.completeness === 'partial' ? 'fill-background' : series.fillClassName;
  if (series.marker === 'square') {
    return (
      <rect
        x={point.x - 3}
        y={point.y - 3}
        width="6"
        height="6"
        className={`${series.className} ${fillClass}`}
        strokeWidth="2"
      />
    );
  }
  if (series.marker === 'diamond') {
    return (
      <rect
        x={point.x - 3}
        y={point.y - 3}
        width="6"
        height="6"
        transform={`rotate(45 ${point.x} ${point.y})`}
        className={`${series.className} ${fillClass}`}
        strokeWidth="2"
      />
    );
  }
  return (
    <circle
      cx={point.x}
      cy={point.y}
      r="3.5"
      className={`${series.className} ${fillClass}`}
      strokeWidth="2"
    />
  );
}

function HistoryChart({
  summary,
  title,
  unit,
  series,
}: Readonly<{
  summary: ReportSummary;
  title: string;
  unit: string;
  series: readonly ChartSeries[];
}>) {
  const [tablePageState, setTablePageState] = useState<ReportTablePageState>(() => ({
    dataset: summary.history,
    page: 0,
  }));
  const currentTablePageState = resetReportTablePageState(tablePageState, summary.history);
  if (currentTablePageState !== tablePageState) setTablePageState(currentTablePageState);
  const { descriptor, domain, fullSeries, plottedSeries } = useMemo(() => {
    const nextDescriptor = getReportAssetDescriptor(summary, unit);
    const nextDomain = getReportChartDomain(
      summary.history,
      series.map((item) => item.key),
      unit,
    );
    const nextFullSeries = series.map((item) => ({
      item,
      points: buildReportChartPoints(
        summary.history,
        item.key,
        unit,
        CHART_DIMENSIONS,
        nextDomain,
        nextDescriptor,
      ),
    }));
    return {
      descriptor: nextDescriptor,
      domain: nextDomain,
      fullSeries: nextFullSeries,
      plottedSeries: nextFullSeries.map(({ item, points }) => ({
        item,
        points: decimateReportChartPoints(points),
      })),
    };
  }, [series, summary, unit]);
  const zeroY = scaleReportChartY(BigInt(0), domain, CHART_DIMENSIONS);
  const hasPartial = fullSeries.some(({ points }) =>
    points.some((point) => point.completeness === 'partial'),
  );
  const historyPage = paginateReportRows(summary.history, currentTablePageState.page);
  const timeZone = summary.metadata.filters.timeZone;
  const firstBucket = summary.history[0];
  const lastBucket = summary.history.at(-1);

  return (
    <Card className="shadow-none">
      <CardHeader className="space-y-3 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{descriptor.symbol ?? descriptor.unit}</span>
            {hasPartial && <Badge variant="warning">Some buckets are partial</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
          {series.map((item) => (
            <span key={item.key} className="flex items-center gap-1.5">
              <svg width="22" height="8" aria-hidden="true">
                <line
                  x1="1"
                  x2="21"
                  y1="4"
                  y2="4"
                  className={item.className}
                  strokeWidth="2"
                  strokeDasharray={item.dash}
                />
              </svg>
              {item.label}
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {summary.history.length === 0 ? (
          <div className="flex h-60 items-center justify-center text-sm text-muted-foreground">
            No history is available for these filters.
          </div>
        ) : (
          <figure>
            <figcaption className="sr-only">
              {title} in {descriptor.symbol ?? descriptor.unit}, grouped by {summary.bucket} using{' '}
              {summary.metadata.filters.dateBasis} dates in {timeZone}.
            </figcaption>
            <svg
              viewBox={`0 0 ${CHART_DIMENSIONS.width} ${CHART_DIMENSIONS.height}`}
              className="h-60 w-full overflow-visible"
              aria-hidden="true"
              focusable="false"
            >
              {[0.25, 0.5, 0.75].map((ratio) => (
                <line
                  key={ratio}
                  x1={CHART_DIMENSIONS.padding}
                  x2={CHART_DIMENSIONS.width - CHART_DIMENSIONS.padding}
                  y1={CHART_DIMENSIONS.height * ratio}
                  y2={CHART_DIMENSIONS.height * ratio}
                  className="stroke-border"
                  strokeWidth="1"
                />
              ))}
              <line
                x1={CHART_DIMENSIONS.padding}
                x2={CHART_DIMENSIONS.width - CHART_DIMENSIONS.padding}
                y1={zeroY}
                y2={zeroY}
                className="stroke-muted-foreground"
                strokeWidth="1.5"
              />
              <text
                x={CHART_DIMENSIONS.padding + 3}
                y={Math.max(12, zeroY - 4)}
                className="fill-muted-foreground"
                fontSize="10"
              >
                0
              </text>
              {plottedSeries.map(({ item, points }) => (
                <g key={item.key}>
                  <path
                    d={buildReportLinePath(points)}
                    fill="none"
                    className={item.className}
                    strokeWidth="2"
                    strokeDasharray={item.dash}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {points
                    .filter((point) => !point.isUnknown)
                    .map((point) => (
                      <SeriesMarker
                        key={`${point.bucketStart.toISOString()}:${item.key}`}
                        point={point}
                        series={item}
                      />
                    ))}
                </g>
              ))}
            </svg>
            <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
              <span>
                {firstBucket ? formatBucket(firstBucket.bucketStart, timeZone, summary.bucket) : ''}
              </span>
              <span>
                {lastBucket ? formatBucket(lastBucket.bucketStart, timeZone, summary.bucket) : ''}
              </span>
            </div>
            {summary.history.length > REPORT_CHART_POINT_LIMIT && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Long history is sampled in the chart. Chart data keeps every bucket.
              </p>
            )}
            <details className="mt-4 rounded-md border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                View chart data
              </summary>
              <div className="overflow-x-auto border-t">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/30 text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Bucket
                      </th>
                      {series.map((item) => (
                        <th key={item.key} scope="col" className="px-3 py-2 font-medium">
                          {item.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {historyPage.items.map((bucket, index) => {
                      const sourceIndex = historyPage.startIndex + index;
                      return (
                        <tr key={bucket.bucketStart.toISOString()} className="border-t">
                          <th scope="row" className="whitespace-nowrap px-3 py-2 font-medium">
                            {formatBucket(bucket.bucketStart, timeZone, summary.bucket)}
                          </th>
                          {fullSeries.map(({ item, points }) => (
                            <td key={item.key} className="whitespace-nowrap px-3 py-2 font-mono">
                              {points[sourceIndex]?.valueText ??
                                `0 ${descriptor.symbol ?? descriptor.unit}`}
                              {points[sourceIndex]?.completeness === 'partial' ? ' (Partial)' : ''}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ReportTablePagination
                page={historyPage.page}
                pageCount={historyPage.pageCount}
                startIndex={historyPage.startIndex}
                endIndex={historyPage.endIndex}
                totalCount={historyPage.totalCount}
                itemLabel="history rows"
                ariaLabel={`${title} chart data pagination`}
                onPageChange={(page) => setTablePageState({ dataset: summary.history, page })}
              />
            </details>
          </figure>
        )}
      </CardContent>
    </Card>
  );
}

export function FinancialHistoryCharts({
  summary,
  roles,
  selectedUnit,
}: Readonly<{
  summary: ReportSummary;
  roles: readonly ReportRole[];
  selectedUnit: string | null;
}>) {
  const roleSet = new Set(roles);
  const valueSeries = [
    ...(roleSet.has('Seller') ? SELLER_VALUE_SERIES : []),
    ...(roleSet.has('Buyer') ? BUYER_VALUE_SERIES : []),
  ];
  const feeSeries = CARDANO_FEE_SERIES.filter(
    (series) => series.key !== 'sellerCardanoFees' || roleSet.has('Seller'),
  ).filter((series) => series.key !== 'buyerCardanoFees' || roleSet.has('Buyer'));

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {selectedUnit ? (
        <HistoryChart
          summary={summary}
          title="Value history"
          unit={selectedUnit}
          series={valueSeries}
        />
      ) : (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Value history</CardTitle>
          </CardHeader>
          <CardContent className="flex h-60 items-center justify-center text-sm text-muted-foreground">
            No recognized value exists for these filters.
          </CardContent>
        </Card>
      )}
      <HistoryChart
        summary={summary}
        title="Cardano fee history"
        unit="lovelace"
        series={feeSeries}
      />
    </div>
  );
}
