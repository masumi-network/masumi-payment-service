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
import { shortenAddress } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCaption,
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

type ReportSummary = PostReportsSummaryResponses[200]['data'];
type ReportFacets = GetReportsFacetsResponses[200]['data'];
type ReportWallet = ReportSummary['wallets'][number];
type ReportRole = ReportWallet['role'];

type FinancialWalletTableProps = Readonly<{
  summary: ReportSummary;
  facets: ReportFacets | null;
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
  const isPartial = metric.completeness === 'partial';
  const fallbackUnit = typeof fallback === 'string' ? fallback : (fallback?.unit ?? '');
  const emptyDisplay = formatReportMetricValue(metric, fallbackUnit, fallback ?? '');

  return (
    <div className="flex min-w-max flex-col items-end gap-1 font-mono text-xs tabular-nums">
      {availableAmounts.length > 0 ? (
        availableAmounts.map((amount) => (
          <span key={amount.unit}>
            {
              formatReportMetricValue({ ...metric, amounts: [amount] }, amount.unit, amount.unit)
                .text
            }
          </span>
        ))
      ) : (
        <span>{emptyDisplay.text}</span>
      )}
      {isPartial && (
        <Badge variant="warning" className="px-1.5 py-0 font-sans text-[10px]">
          Partial
        </Badge>
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

function visibleMetricKeys(role: ReportRole): ReportMetricKey[] {
  const roleMetrics = ROLE_METRICS[role];
  return [
    roleMetrics.gross,
    roleMetrics.adjustment,
    roleMetrics.actorCardanoFee,
    roleMetrics.net,
    'actorCardanoFees',
    'adminCardanoFees',
    'totalCardanoFees',
  ];
}

function WalletIdentity({
  wallet,
  note,
}: Readonly<{ wallet: ReportWallet['managedWallet']; note: string | null }>) {
  if (!wallet) {
    return (
      <div>
        <div className="font-medium">Unassigned</div>
        <div className="text-xs text-muted-foreground">No managed wallet</div>
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
      <div className="font-mono text-[11px] text-muted-foreground" title={wallet.id}>
        ID {shortenAddress(wallet.id, 5)}
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
    onlyRole === 'Seller' ? 'Gross revenue' : onlyRole === 'Buyer' ? 'Gross spend' : 'Gross';
  const adjustmentHeading =
    onlyRole === 'Seller'
      ? 'Protocol fee'
      : onlyRole === 'Buyer'
        ? 'Returned funds'
        : 'Protocol / returned';
  const actorFeeHeading =
    onlyRole === 'Seller'
      ? 'Seller Cardano fee'
      : onlyRole === 'Buyer'
        ? 'Buyer Cardano fee'
        : 'Actor Cardano fee';
  const netHeading =
    onlyRole === 'Seller' ? 'Net revenue' : onlyRole === 'Buyer' ? 'Net spend' : 'Net';
  const columnCount = showRole ? 11 : 10;

  return (
    <>
      <Table>
        <TableCaption>
          Counts are distinct logical payments inside each wallet and role group, so group counts
          are not additive. Reconciled actor, admin, and total fees use the stable owner named by
          report warnings when a component spans groups.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Wallet</TableHead>
            {showRole && <TableHead scope="col">Role</TableHead>}
            <TableHead scope="col" className="text-right">
              Transactions
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
              Reconciled actor
            </TableHead>
            <TableHead scope="col" className="text-right">
              Admin fee
            </TableHead>
            <TableHead scope="col" className="text-right">
              Total fee
            </TableHead>
            <TableHead scope="col">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                No wallet activity matches these report filters.
              </TableCell>
            </TableRow>
          ) : (
            walletPage.items.map((wallet) => {
              const roleMetrics = ROLE_METRICS[wallet.role];
              const visibleKeys = visibleMetricKeys(wallet.role);
              const isPartial =
                wallet.metrics.transactionCountCompleteness === 'partial' ||
                visibleKeys.some(
                  (metricKey) => wallet.metrics[metricKey].completeness === 'partial',
                );
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
                      <Badge variant="secondary">{wallet.role}</Badge>
                    </TableHead>
                  )}
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatReportCountValue(
                      wallet.metrics.transactionCount,
                      wallet.metrics.transactionCountCompleteness,
                    )}
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
                      metric={metricForUnit(wallet.metrics, 'actorCardanoFees', CARDANO_UNIT)}
                      fallback={CARDANO_UNIT}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <MetricValue
                      metric={metricForUnit(wallet.metrics, 'adminCardanoFees', CARDANO_UNIT)}
                      fallback={CARDANO_UNIT}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <MetricValue
                      metric={metricForUnit(wallet.metrics, 'totalCardanoFees', CARDANO_UNIT)}
                      fallback={CARDANO_UNIT}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant={isPartial ? 'warning' : 'success'}>
                      {isPartial ? 'Partial' : 'Complete'}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      <ReportTablePagination
        page={walletPage.page}
        pageCount={walletPage.pageCount}
        startIndex={walletPage.startIndex}
        endIndex={walletPage.endIndex}
        totalCount={walletPage.totalCount}
        itemLabel="wallet rows"
        ariaLabel="Wallet and role breakdown pagination"
        onPageChange={(page) => setTablePageState({ dataset: summary.wallets, page })}
      />
    </>
  );
}
