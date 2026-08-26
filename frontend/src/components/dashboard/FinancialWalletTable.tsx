import { useMemo, useState } from 'react';
import type { GetReportsFacetsResponses, PostReportsSummaryResponses } from '@/lib/api/generated';
import {
  formatReportCountValue,
  formatReportMetricValue,
  getReportAssetDescriptor,
  getReportMetricAmount,
  type ReportAmountFallback,
  type ReportMetric,
  type ReportMetricKey,
  type ReportMetrics,
} from '@/lib/transaction-report/dashboard-metrics';
import { REPORT_METRIC_LABELS } from '@/lib/transaction-report/report-labels';
import { shortenAddress } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  paginateReportRows,
  resetReportTablePageState,
  type ReportTablePageState,
} from '@/lib/transaction-report/report-rendering';
import { ReportTablePagination } from './ReportTablePagination';
import { EstimateDot } from './report/ReportCompleteness';

type ReportSummary = PostReportsSummaryResponses[200]['data'];
type ReportFacets = GetReportsFacetsResponses[200]['data'];
type ReportWallet = ReportSummary['wallets'][number];
type ReportRole = ReportWallet['role'];

type FinancialWalletTableProps = Readonly<{
  summary: ReportSummary;
  facets: Pick<ReportFacets, 'managedWallets'> | null;
  selectedUnit: string | null;
  roles: readonly ReportRole[];
}>;

type RoleMetricKeys = Readonly<{
  gross: ReportMetricKey;
  adjustment: ReportMetricKey;
  actorCardanoFee: ReportMetricKey;
  net: ReportMetricKey;
}>;

const ROLE_METRICS: Record<ReportRole, RoleMetricKeys> = {
  Seller: {
    gross: 'sellerGrossRevenue',
    adjustment: 'protocolFees',
    actorCardanoFee: 'sellerCardanoFees',
    net: 'sellerNetRevenue',
  },
  Buyer: {
    gross: 'buyerGrossSpend',
    adjustment: 'returnedFunds',
    actorCardanoFee: 'buyerCardanoFees',
    net: 'buyerNetSpend',
  },
};

const CARDANO_UNIT = 'lovelace';

function uniqueRoles(roles: readonly ReportRole[]): ReportRole[] {
  return [...new Set(roles)];
}

function walletLabel(wallet: ReportWallet, notesByWalletId: ReadonlyMap<string, string>): string {
  if (!wallet.managedWallet) return 'Unassigned';
  return notesByWalletId.get(wallet.managedWallet.id) ?? wallet.managedWallet.walletAddress;
}

function sortWallets(
  wallets: readonly ReportWallet[],
  notesByWalletId: ReadonlyMap<string, string>,
): ReportWallet[] {
  const roleOrder: Record<ReportRole, number> = { Seller: 0, Buyer: 1 };
  return [...wallets].sort((left, right) => {
    if (!left.managedWallet && right.managedWallet) return 1;
    if (left.managedWallet && !right.managedWallet) return -1;

    const labelOrder = walletLabel(left, notesByWalletId).localeCompare(
      walletLabel(right, notesByWalletId),
      undefined,
      { sensitivity: 'base' },
    );
    if (labelOrder !== 0) return labelOrder;

    const idOrder = (left.managedWallet?.id ?? '').localeCompare(right.managedWallet?.id ?? '');
    if (idOrder !== 0) return idOrder;
    return roleOrder[left.role] - roleOrder[right.role];
  });
}

function MetricValue({
  metric,
  fallback,
}: Readonly<{ metric: ReportMetric; fallback: ReportAmountFallback | null }>) {
  const availableAmounts = metric.amounts;
  const fallbackUnit = typeof fallback === 'string' ? fallback : (fallback?.unit ?? '');
  const emptyDisplay = formatReportMetricValue(metric, fallbackUnit, fallback ?? '');

  return (
    <div className="flex min-w-max flex-col items-end gap-0.5 font-mono text-xs tabular-nums">
      {availableAmounts.length > 0 ? (
        availableAmounts.map((amount) => (
          <span key={amount.unit} className="inline-flex items-start gap-1">
            {
              formatReportMetricValue({ ...metric, amounts: [amount] }, amount.unit, amount.unit)
                .text
            }
            {metric.completeness === 'partial' && <EstimateDot />}
          </span>
        ))
      ) : (
        <span className="inline-flex items-start gap-1">
          {emptyDisplay.text}
          {metric.completeness === 'partial' && <EstimateDot />}
        </span>
      )}
    </div>
  );
}

function metricForUnit(
  metrics: ReportMetrics,
  metricKey: ReportMetricKey,
  unit: string,
): ReportMetric {
  const metric = metrics[metricKey];
  const amount = getReportMetricAmount(metrics, metricKey, unit);
  return { ...metric, amounts: amount ? [amount] : [] };
}

function WalletIdentity({
  wallet,
  note,
}: Readonly<{ wallet: ReportWallet['managedWallet']; note: string | null }>) {
  if (!wallet) {
    return (
      <div>
        <div className="font-medium">Unassigned</div>
        <div className="text-xs text-muted-foreground">Not linked to a managed wallet</div>
      </div>
    );
  }

  return (
    <div className="min-w-48">
      <div className="flex items-center gap-2">
        <span className="max-w-52 truncate font-medium" title={note ?? wallet.walletAddress}>
          {note ?? 'Managed wallet'}
        </span>
        {wallet.deletedAt && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            Archived
          </Badge>
        )}
      </div>
      <div className="font-mono text-xs text-muted-foreground" title={wallet.walletAddress}>
        {shortenAddress(wallet.walletAddress, 7)}
      </div>
    </div>
  );
}

export function FinancialWalletTable({
  summary,
  facets,
  selectedUnit,
  roles,
}: FinancialWalletTableProps) {
  const [tablePageState, setTablePageState] = useState<ReportTablePageState>(() => ({
    dataset: summary.wallets,
    page: 0,
  }));
  const currentTablePageState = resetReportTablePageState(tablePageState, summary.wallets);
  if (currentTablePageState !== tablePageState) setTablePageState(currentTablePageState);
  const selectedRoles = uniqueRoles(roles);
  const roleSet = new Set(selectedRoles);
  const showRole = roleSet.has('Buyer') && roleSet.has('Seller');
  const onlyRole = selectedRoles.length === 1 ? selectedRoles[0] : null;
  const notesByWalletId = useMemo(
    () =>
      new Map(
        (facets?.managedWallets ?? [])
          .map((wallet) => [wallet.id, wallet.note?.trim() ?? ''] as const)
          .filter((entry) => entry[1].length > 0),
      ),
    [facets],
  );
  const rows = useMemo(
    () =>
      sortWallets(
        summary.wallets.filter((wallet) => roles.includes(wallet.role)),
        notesByWalletId,
      ),
    [notesByWalletId, roles, summary.wallets],
  );
  const walletPage = paginateReportRows(rows, currentTablePageState.page);
  const selectedAsset =
    selectedUnit == null ? null : getReportAssetDescriptor(summary, selectedUnit);

  const grossHeading =
    onlyRole === 'Seller'
      ? REPORT_METRIC_LABELS.sellerGrossRevenue
      : onlyRole === 'Buyer'
        ? REPORT_METRIC_LABELS.buyerGrossSpend
        : 'Gross';
  const adjustmentHeading =
    onlyRole === 'Seller'
      ? REPORT_METRIC_LABELS.protocolFees
      : onlyRole === 'Buyer'
        ? REPORT_METRIC_LABELS.returnedFunds
        : 'Fee or refund';
  const actorFeeHeading =
    onlyRole === 'Seller'
      ? REPORT_METRIC_LABELS.sellerCardanoFees
      : onlyRole === 'Buyer'
        ? REPORT_METRIC_LABELS.buyerCardanoFees
        : 'Own network fees';
  const netHeading =
    onlyRole === 'Seller'
      ? REPORT_METRIC_LABELS.sellerNetRevenue
      : onlyRole === 'Buyer'
        ? REPORT_METRIC_LABELS.buyerNetSpend
        : 'Net';
  const columnCount = showRole ? 8 : 7;

  return (
    <>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Wallet</TableHead>
              {showRole && <TableHead scope="col">Side</TableHead>}
              <TableHead scope="col" className="text-right">
                Payments
              </TableHead>
              <TableHead scope="col" className="text-right">
                {grossHeading}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {adjustmentHeading}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {actorFeeHeading}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {netHeading}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {REPORT_METRIC_LABELS.totalCardanoFees}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                  No wallet was active in this period.
                </TableCell>
              </TableRow>
            ) : (
              walletPage.items.map((wallet) => {
                const roleMetrics = ROLE_METRICS[wallet.role];
                const businessMetric = (metricKey: ReportMetricKey) =>
                  selectedUnit == null
                    ? wallet.metrics[metricKey]
                    : metricForUnit(wallet.metrics, metricKey, selectedUnit);

                return (
                  <TableRow key={`${wallet.managedWallet?.id ?? 'unassigned'}:${wallet.role}`}>
                    <TableHead scope="row" className="h-auto py-2 text-foreground">
                      <WalletIdentity
                        wallet={wallet.managedWallet}
                        note={
                          wallet.managedWallet
                            ? (notesByWalletId.get(wallet.managedWallet.id) ?? null)
                            : null
                        }
                      />
                    </TableHead>
                    {showRole && (
                      <TableHead scope="row" className="h-auto py-2 text-foreground">
                        <Badge variant="secondary">
                          {wallet.role === 'Seller' ? 'Selling' : 'Buying'}
                        </Badge>
                      </TableHead>
                    )}
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      <span className="inline-flex items-start gap-1">
                        {formatReportCountValue(
                          wallet.metrics.transactionCount,
                          wallet.metrics.transactionCountCompleteness,
                        )}
                        {wallet.metrics.transactionCountCompleteness === 'partial' && (
                          <EstimateDot />
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <MetricValue
                        metric={businessMetric(roleMetrics.gross)}
                        fallback={selectedAsset}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <MetricValue
                        metric={businessMetric(roleMetrics.adjustment)}
                        fallback={selectedAsset}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <MetricValue
                        metric={metricForUnit(
                          wallet.metrics,
                          roleMetrics.actorCardanoFee,
                          CARDANO_UNIT,
                        )}
                        fallback={CARDANO_UNIT}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <MetricValue
                        metric={businessMetric(roleMetrics.net)}
                        fallback={selectedAsset}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <MetricValue
                        metric={metricForUnit(wallet.metrics, 'totalCardanoFees', CARDANO_UNIT)}
                        fallback={CARDANO_UNIT}
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        A wallet that both sells and buys gets one row per side. Payment counts are per row, so they
        do not add up to the total above.
      </p>
      <ReportTablePagination
        page={walletPage.page}
        pageCount={walletPage.pageCount}
        startIndex={walletPage.startIndex}
        endIndex={walletPage.endIndex}
        totalCount={walletPage.totalCount}
        itemLabel="wallet rows"
        ariaLabel="Wallet breakdown pagination"
        onPageChange={(page) => setTablePageState({ dataset: summary.wallets, page })}
      />
    </>
  );
}
