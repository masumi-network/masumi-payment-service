import { useMemo } from 'react';
import { ArrowUpDown, Fuel, TrendingDown, TrendingUp } from 'lucide-react';
import { InfoHint } from '@/components/ui/info-hint';
import { StatCard } from '@/components/ui/stat-card';
import {
  formatReportCountValue,
  getReportAssetDescriptor,
  type ReportMetricKey,
  type ReportSummary,
} from '@/lib/transaction-report/dashboard-metrics';
import { buildReportChartRows } from '@/lib/transaction-report/chart-data';
import { REPORT_METRIC_LABELS, REPORT_SERIES_COLORS } from '@/lib/transaction-report/report-labels';
import { ReportChart, ReportChartLegend, type ReportChartSeries } from './ReportChart';
import { ReportHistoryTable } from './ReportHistoryTable';
import { EstimateDot } from './ReportCompleteness';
import { ReportMetricTile, ReportMetricValue, scopeMetricToUnit } from './ReportMetricTile';

type ReportRole = ReportSummary['wallets'][number]['role'];

const FEE_METRIC_KEYS = [
  'protocolFees',
  'actorCardanoFees',
  'adminCardanoFees',
  'totalCardanoFees',
] as const satisfies readonly ReportMetricKey[];

function headlineMetricKeys(hasSeller: boolean, hasBuyer: boolean): ReportMetricKey[] {
  if (hasSeller && hasBuyer) return ['sellerNetRevenue', 'buyerNetSpend', 'totalCardanoFees'];
  if (hasSeller) return ['sellerNetRevenue', 'protocolFees', 'totalCardanoFees'];
  if (hasBuyer) return ['buyerNetSpend', 'returnedFunds', 'totalCardanoFees'];
  return ['totalCardanoFees'];
}

const HEADLINE_STYLE: Partial<Record<ReportMetricKey, { color: string; icon: React.ReactNode }>> = {
  sellerNetRevenue: {
    color: REPORT_SERIES_COLORS.revenue,
    icon: <TrendingUp className="h-4 w-4" style={{ color: REPORT_SERIES_COLORS.revenue }} />,
  },
  buyerNetSpend: {
    color: REPORT_SERIES_COLORS.spend,
    icon: <TrendingDown className="h-4 w-4" style={{ color: REPORT_SERIES_COLORS.spend }} />,
  },
  protocolFees: {
    color: REPORT_SERIES_COLORS.protocolFee,
    icon: <Fuel className="h-4 w-4" style={{ color: REPORT_SERIES_COLORS.protocolFee }} />,
  },
  returnedFunds: {
    color: REPORT_SERIES_COLORS.refund,
    icon: <TrendingDown className="h-4 w-4" style={{ color: REPORT_SERIES_COLORS.refund }} />,
  },
  totalCardanoFees: {
    color: REPORT_SERIES_COLORS.networkFee,
    icon: <Fuel className="h-4 w-4" style={{ color: REPORT_SERIES_COLORS.networkFee }} />,
  },
};

/**
 * The one series on this chart that is not settled money, so it is the one an
 * operator is most likely to read as revenue. The explanation travels with the
 * legend entry rather than sitting in the section note, because that is where
 * the name is read.
 */
const PENDING_REVENUE_HINT = (
  <>
    <p>
      Money a buyer locked in escrow for a request that has not settled. It is not revenue yet, so
      it is left out of every revenue and fee figure.
    </p>
    <p>
      The request can still end two ways. The seller delivers, and the amount becomes gross revenue.
      Or the buyer is refunded, and it becomes returned funds.
    </p>
    <p>
      Until then it sits on the day the funds were locked, because that is the only date this money
      has. When the request settles, the amount leaves this line and moves to the day it settled. A
      slow request can shift days or weeks forward, so expect this line to change shape.
    </p>
    <p>The figure is the full amount asked for, before the protocol fee and network fees.</p>
  </>
);

function combinedSeries(hasSeller: boolean, hasBuyer: boolean): ReportChartSeries[] {
  return [
    ...(hasSeller
      ? ([
          {
            key: 'sellerGrossRevenue',
            label: 'Gross revenue',
            color: REPORT_SERIES_COLORS.revenue,
            kind: 'area',
          },
          {
            key: 'sellerNetRevenue',
            label: 'Net revenue',
            color: REPORT_SERIES_COLORS.revenue,
          },
          {
            key: 'sellerPendingRevenue',
            label: REPORT_METRIC_LABELS.sellerPendingRevenue,
            color: REPORT_SERIES_COLORS.pending,
            dashed: true,
            hint: PENDING_REVENUE_HINT,
          },
        ] as const)
      : []),
    ...(hasBuyer
      ? ([
          {
            key: 'buyerGrossSpend',
            label: 'Gross spend',
            color: REPORT_SERIES_COLORS.spend,
            kind: 'area',
          },
          {
            key: 'buyerNetSpend',
            label: 'Net spend',
            color: REPORT_SERIES_COLORS.spend,
          },
        ] as const)
      : []),
  ];
}

/**
 * The one screen an operator should be able to read without training: how many
 * payments ran, what came in, what went out, and what it all cost. Every other
 * tab is the detail behind one of these numbers.
 */
export function ReportOverviewTab({
  summary,
  roles,
  selectedUnit,
}: Readonly<{
  summary: ReportSummary;
  roles: readonly ReportRole[];
  selectedUnit: string | null;
}>) {
  const roleSet = new Set(roles);
  const hasSeller = roleSet.has('Seller');
  const hasBuyer = roleSet.has('Buyer');
  const businessDescriptor = selectedUnit ? getReportAssetDescriptor(summary, selectedUnit) : null;
  const cardanoDescriptor = getReportAssetDescriptor(summary, 'lovelace');
  const headlineKeys = headlineMetricKeys(hasSeller, hasBuyer);
  const series = combinedSeries(hasSeller, hasBuyer);

  const rows = useMemo(
    () =>
      selectedUnit == null
        ? []
        : buildReportChartRows(
            summary,
            selectedUnit,
            series.map((entry) => entry.key),
            getReportAssetDescriptor(summary, selectedUnit),
          ),
    [selectedUnit, series, summary],
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Payments"
          index={0}
          icon={<ArrowUpDown className="h-4 w-4 text-purple-500" />}
          accentColor="rgb(168, 85, 247)"
        >
          <div className="inline-flex items-start gap-1 text-2xl font-semibold">
            {formatReportCountValue(
              summary.totals.transactionCount,
              summary.totals.transactionCountCompleteness,
            )}
            {summary.totals.transactionCountCompleteness === 'partial' && <EstimateDot />}
          </div>
        </StatCard>
        {headlineKeys.map((metricKey, index) => {
          const style = HEADLINE_STYLE[metricKey];
          const isCardanoFee = metricKey === 'totalCardanoFees';
          const descriptor = isCardanoFee ? cardanoDescriptor : businessDescriptor;
          return (
            <StatCard
              key={metricKey}
              label={REPORT_METRIC_LABELS[metricKey]}
              index={index + 1}
              icon={style?.icon}
              accentColor={style?.color}
            >
              <ReportMetricValue
                metric={scopeMetricToUnit(summary.totals, metricKey, descriptor?.unit ?? null)}
                descriptor={descriptor}
                className="text-xl font-semibold xl:text-2xl"
              />
            </StatCard>
          );
        })}
      </div>

      <div className="rounded-lg border p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1">
              <div className="font-medium">Money in and out</div>
              <InfoHint label="gross and net">
                <p>Gross is the amount the request was for, before anything is taken off.</p>
                <p>
                  Net revenue is what the seller keeps: gross less the protocol fee, the network
                  fees, and anything refunded. It is smaller than gross.
                </p>
                <p>
                  Net spend is what the purchase cost the buyer: gross plus the network fees the
                  buyer paid, less anything refunded. It is larger than gross whenever the buyer
                  paid a network fee, which is normal rather than a mistake.
                </p>
                {hasSeller && (
                  <p>
                    The dashed <strong>{REPORT_METRIC_LABELS.sellerPendingRevenue}</strong> line is
                    money still held in escrow. Open the info icon beside it in the legend for what
                    happens to it.
                  </p>
                )}
              </InfoHint>
            </div>
            <p className="text-sm text-muted-foreground">
              Gross is the amount asked for. Net counts the fees as well: taken off revenue, added
              to spend.
            </p>
          </div>
          <ReportChartLegend series={series} />
        </div>
        {selectedUnit == null ? (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            Nothing was paid or earned in this period.
          </div>
        ) : (
          <>
            <ReportChart rows={rows} series={series} height={288} />
            <ReportHistoryTable rows={rows} series={series} label="Money in and out" />
          </>
        )}
      </div>

      <div>
        <div className="mb-3">
          <div className="font-medium">What it cost</div>
          <p className="text-sm text-muted-foreground">
            The payment source keeps the protocol fee. Cardano charges the network fees.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {FEE_METRIC_KEYS.map((metricKey) => (
            <ReportMetricTile
              key={metricKey}
              metricKey={metricKey}
              metrics={summary.totals}
              descriptor={metricKey === 'protocolFees' ? businessDescriptor : cardanoDescriptor}
              accentColor={
                metricKey === 'protocolFees'
                  ? REPORT_SERIES_COLORS.protocolFee
                  : REPORT_SERIES_COLORS.networkFee
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
