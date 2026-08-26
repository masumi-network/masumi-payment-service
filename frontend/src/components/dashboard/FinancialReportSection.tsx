import { useMemo, useState } from 'react';
import { Download, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { shortenAddress } from '@/lib/utils';
import {
  collectReportAssetUnits,
  getReportAssetDescriptor,
  resolveReportAssetUnit,
} from '@/lib/transaction-report/dashboard-metrics';
import {
  REPORT_DATE_PRESET_LABELS,
  REPORT_METRIC_LABELS,
  REPORT_SERIES_COLORS,
} from '@/lib/transaction-report/report-labels';
import { DownloadDetailsDialog } from '@/components/transactions/DownloadDetailsDialog';
import { FinancialWalletTable } from './FinancialWalletTable';
import { ReportCompletenessNote } from './report/ReportCompleteness';
import { NO_FIAT_CURRENCY } from '@/lib/transaction-report/fiat-settings';
import { ReportFilterBar } from './report/ReportFilterBar';
import { ReportOverviewTab } from './report/ReportOverviewTab';
import { ReportSeriesTab } from './report/ReportSeriesTab';
import { ReportViewSwitch } from './report/ReportViewSwitch';
import { useFinancialReportModel } from './useFinancialReportModel';

const EXPORT_VIEW_DEFAULTS = {
  roles: ['Buyer', 'Seller'],
  states: [],
  hasUnmappedFilters: false,
} as const;

const OVERVIEW_TAB = 'Overview';
const REVENUE_TAB = 'Revenue';
const SPENDING_TAB = 'Spending';
const FEES_TAB = 'Fees';
const WALLETS_TAB = 'Wallets';

function ReportLoadingState() {
  return (
    <div className="space-y-4" aria-label="Building the report">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-3 rounded-lg border p-6">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-40" />
          </div>
        ))}
      </div>
      <Skeleton className="h-72 w-full rounded-lg" />
    </div>
  );
}

export function FinancialReportSection() {
  const model = useFinancialReportModel();
  const [requestedUnit, setRequestedUnit] = useState('');
  const [requestedTab, setRequestedTab] = useState(OVERVIEW_TAB);
  const [isExportOpen, setIsExportOpen] = useState(false);

  const summary = model.summary;
  const assetUnits = summary ? collectReportAssetUnits(summary) : [];
  const fiatUnit =
    model.form.fiatCurrency === NO_FIAT_CURRENCY ? null : `fiat:${model.form.fiatCurrency}`;
  const selectedUnit = resolveReportAssetUnit(assetUnits, requestedUnit, fiatUnit);
  const roleSet = new Set(model.form.roles);
  const hasSeller = roleSet.has('Seller');
  const hasBuyer = roleSet.has('Buyer');

  const views = useMemo(
    () => [
      OVERVIEW_TAB,
      ...(hasSeller ? [REVENUE_TAB] : []),
      ...(hasBuyer ? [SPENDING_TAB] : []),
      FEES_TAB,
      WALLETS_TAB,
    ],
    [hasBuyer, hasSeller],
  );
  // Turning a side off can remove the open view, so fall back rather than
  // leaving the reader on a view that no longer exists.
  const activeTab = views.includes(requestedTab) ? requestedTab : OVERVIEW_TAB;

  const isBusy = model.isLoadingFacets || model.isLoadingSummary || model.isRefetching;
  const periodLabel = REPORT_DATE_PRESET_LABELS[model.form.datePreset];
  const generatedAt = summary
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: summary.metadata.filters.timeZone,
      }).format(summary.metadata.generatedAt)
    : null;
  const assetLabel = (unit: string) =>
    summary
      ? (getReportAssetDescriptor(summary, unit).symbol ?? shortenAddress(unit, 8))
      : shortenAddress(unit, 8);

  const statusMessage = model.facetsError
    ? { tone: 'error' as const, text: model.facetsError }
    : model.fiatIssue
      ? { tone: 'error' as const, text: model.fiatIssue.message }
      : model.bodyError
        ? { tone: 'error' as const, text: model.bodyError }
        : model.summaryError
          ? { tone: 'error' as const, text: model.summaryError }
          : model.exportError
            ? { tone: 'error' as const, text: model.exportError }
            : model.isLoadingFacets
              ? { tone: 'busy' as const, text: 'Loading the filters…' }
              : isBusy
                ? { tone: 'busy' as const, text: 'Building the report…' }
                : model.paymentSources.length === 0
                  ? { tone: 'quiet' as const, text: 'This network has no payment source yet.' }
                  : null;

  const resetReport = () => {
    setRequestedUnit('');
    setRequestedTab(OVERVIEW_TAB);
    model.reset();
  };

  return (
    <section
      id="financial-reporting"
      className="space-y-4"
      aria-labelledby="financial-reporting-title"
      aria-busy={isBusy}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 id="financial-reporting-title" className="text-lg font-semibold">
            Money and fees
          </h2>
          <p className="text-sm text-muted-foreground">
            What this payment source earned, spent, and paid in fees.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{periodLabel}</span>
            {generatedAt && <span>· Updated {generatedAt}</span>}
            {summary && (
              <ReportCompletenessNote warnings={summary.metadata.warnings} className="ml-1" />
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={resetReport}>
            <RotateCcw className="h-4 w-4" /> Reset
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={model.refresh}
            disabled={isBusy || model.body == null}
          >
            <RefreshCw className={isBusy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setIsExportOpen(true)}
            disabled={model.body == null}
          >
            <Download className="h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      <ReportFilterBar
        form={model.form}
        isLoading={model.isLoadingFacets}
        managedWallets={model.managedWallets}
        paymentSources={model.paymentSources}
        assetUnits={assetUnits}
        selectedUnit={selectedUnit}
        assetLabel={assetLabel}
        onSelectUnit={setRequestedUnit}
        onSetPaymentSource={model.setPaymentSource}
        onToggleRole={model.toggleRole}
        onToggleState={model.toggleState}
        onToggleWallet={model.toggleWallet}
        onUpdate={model.updateForm}
        fiatCapability={model.fiatCapability}
        fiatIssue={model.fiatIssue}
      />

      {statusMessage && (
        <p
          aria-live="polite"
          className={
            statusMessage.tone === 'error'
              ? 'text-sm text-destructive'
              : 'flex items-center gap-2 text-sm text-muted-foreground'
          }
        >
          {statusMessage.tone === 'busy' && <Loader2 className="h-4 w-4 animate-spin" />}
          {statusMessage.text}
        </p>
      )}

      {isBusy && !summary ? (
        <ReportLoadingState />
      ) : summary ? (
        <div className="space-y-5">
          <ReportViewSwitch views={views} activeView={activeTab} onSelect={setRequestedTab} />

          {activeTab === OVERVIEW_TAB && (
            <ReportOverviewTab
              summary={summary}
              roles={model.form.roles}
              selectedUnit={selectedUnit}
            />
          )}

          {activeTab === REVENUE_TAB && selectedUnit && (
            <ReportSeriesTab
              summary={summary}
              unit={selectedUnit}
              title="Revenue over time"
              description="What selling brought in, before and after the protocol fee."
              metricKeys={[
                'sellerGrossRevenue',
                'protocolFees',
                'sellerCardanoFees',
                'sellerNetRevenue',
              ]}
              accents={{
                sellerGrossRevenue: REPORT_SERIES_COLORS.revenue,
                protocolFees: REPORT_SERIES_COLORS.protocolFee,
                sellerCardanoFees: REPORT_SERIES_COLORS.networkFee,
                sellerNetRevenue: REPORT_SERIES_COLORS.revenue,
              }}
              series={[
                {
                  key: 'sellerGrossRevenue',
                  label: REPORT_METRIC_LABELS.sellerGrossRevenue,
                  color: REPORT_SERIES_COLORS.revenue,
                  kind: 'area',
                },
                {
                  key: 'protocolFees',
                  label: REPORT_METRIC_LABELS.protocolFees,
                  color: REPORT_SERIES_COLORS.protocolFee,
                },
                {
                  key: 'sellerNetRevenue',
                  label: REPORT_METRIC_LABELS.sellerNetRevenue,
                  color: REPORT_SERIES_COLORS.revenue,
                },
              ]}
              emptyMessage="Nothing was sold in this period."
            />
          )}

          {activeTab === SPENDING_TAB && selectedUnit && (
            <ReportSeriesTab
              summary={summary}
              unit={selectedUnit}
              title="Spending over time"
              description="What buying cost, before and after refunds came back."
              metricKeys={['buyerGrossSpend', 'returnedFunds', 'buyerCardanoFees', 'buyerNetSpend']}
              accents={{
                buyerGrossSpend: REPORT_SERIES_COLORS.spend,
                returnedFunds: REPORT_SERIES_COLORS.refund,
                buyerCardanoFees: REPORT_SERIES_COLORS.networkFee,
                buyerNetSpend: REPORT_SERIES_COLORS.spend,
              }}
              series={[
                {
                  key: 'buyerGrossSpend',
                  label: REPORT_METRIC_LABELS.buyerGrossSpend,
                  color: REPORT_SERIES_COLORS.spend,
                  kind: 'area',
                },
                {
                  key: 'returnedFunds',
                  label: REPORT_METRIC_LABELS.returnedFunds,
                  color: REPORT_SERIES_COLORS.refund,
                },
                {
                  key: 'buyerNetSpend',
                  label: REPORT_METRIC_LABELS.buyerNetSpend,
                  color: REPORT_SERIES_COLORS.spend,
                },
              ]}
              emptyMessage="Nothing was bought in this period."
            />
          )}

          {(activeTab === REVENUE_TAB || activeTab === SPENDING_TAB) && !selectedUnit && (
            <div className="rounded-lg border p-6 text-sm text-muted-foreground">
              Nothing was paid or earned in this period.
            </div>
          )}

          {activeTab === FEES_TAB && (
            <ReportSeriesTab
              summary={summary}
              unit="lovelace"
              title="Network fees over time"
              description="Cardano charges a fee per transaction. This is who paid it."
              metricKeys={[
                ...(hasSeller ? (['sellerCardanoFees'] as const) : []),
                ...(hasBuyer ? (['buyerCardanoFees'] as const) : []),
                'adminCardanoFees',
                'totalCardanoFees',
              ]}
              accents={{
                sellerCardanoFees: REPORT_SERIES_COLORS.revenue,
                buyerCardanoFees: REPORT_SERIES_COLORS.spend,
                adminCardanoFees: REPORT_SERIES_COLORS.admin,
                totalCardanoFees: REPORT_SERIES_COLORS.networkFee,
              }}
              series={[
                {
                  key: 'totalCardanoFees',
                  label: REPORT_METRIC_LABELS.totalCardanoFees,
                  color: REPORT_SERIES_COLORS.networkFee,
                  kind: 'area',
                },
                // Per bucket the service reports each side separately. The
                // combined actor figure only exists on the totals, so charting
                // it would draw a flat zero line under real per-side values.
                ...(hasSeller
                  ? [
                      {
                        key: 'sellerCardanoFees' as const,
                        label: REPORT_METRIC_LABELS.sellerCardanoFees,
                        color: REPORT_SERIES_COLORS.revenue,
                      },
                    ]
                  : []),
                ...(hasBuyer
                  ? [
                      {
                        key: 'buyerCardanoFees' as const,
                        label: REPORT_METRIC_LABELS.buyerCardanoFees,
                        color: REPORT_SERIES_COLORS.spend,
                      },
                    ]
                  : []),
                {
                  key: 'adminCardanoFees',
                  label: REPORT_METRIC_LABELS.adminCardanoFees,
                  color: REPORT_SERIES_COLORS.admin,
                  dashed: true,
                },
              ]}
              emptyMessage="No transaction fee was charged in this period."
            />
          )}

          {activeTab === WALLETS_TAB && (
            <div>
              <div className="mb-3">
                <div className="font-medium">By wallet</div>
                <p className="text-sm text-muted-foreground">
                  The same figures, split across the wallets that moved the money.
                </p>
              </div>
              <FinancialWalletTable
                summary={summary}
                facets={{ managedWallets: model.managedWallets }}
                selectedUnit={selectedUnit}
                roles={model.form.roles}
              />
            </div>
          )}
        </div>
      ) : null}

      {isExportOpen && (
        <DownloadDetailsDialog
          open
          onClose={() => setIsExportOpen(false)}
          viewDefaults={EXPORT_VIEW_DEFAULTS}
          initialForm={model.form}
        />
      )}
    </section>
  );
}
