import { useState } from 'react';
import { Download, Loader2, RefreshCw, RotateCcw, TrendingUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { shortenAddress } from '@/lib/utils';
import {
  collectReportAssetUnits,
  getReportAssetDescriptor,
  getReportTransactionCountDisplay,
  resolveReportAssetUnit,
} from '@/lib/transaction-report/dashboard-metrics';
import { FinancialHistoryCharts } from './FinancialHistoryCharts';
import { FinancialMetricCards } from './FinancialMetricCards';
import { FinancialReportFilters } from './FinancialReportFilters';
import { FinancialWalletTable } from './FinancialWalletTable';
import { useFinancialReportModel } from './useFinancialReportModel';

function humanize(value: string): string {
  return value.replace(/([A-Z])/g, ' $1').trim();
}

function ReportLoadingState() {
  return (
    <div className="space-y-4" aria-label="Calculating financial report">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index} className="shadow-none">
            <CardContent className="space-y-3 p-5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-7 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function FinancialReportSection() {
  const model = useFinancialReportModel();
  const [requestedUnit, setRequestedUnit] = useState('');
  const assetUnits = model.summary ? collectReportAssetUnits(model.summary) : [];
  const selectedUnit = resolveReportAssetUnit(assetUnits, requestedUnit);
  const summary = model.summary;
  const transactionCountDisplay = summary
    ? getReportTransactionCountDisplay(
        summary.totals.transactionCount,
        summary.totals.transactionCountCompleteness,
        'distinct logical payment',
      )
    : null;
  const isBusy = model.isLoadingFacets || model.isLoadingSummary || model.isRefetching;
  const generatedAt = summary
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: summary.metadata.filters.timeZone,
      }).format(summary.metadata.generatedAt)
    : null;
  const resetReport = () => {
    setRequestedUnit('');
    model.reset();
  };

  return (
    <section
      id="financial-reporting"
      className="space-y-4"
      aria-labelledby="financial-reporting-title"
      aria-busy={isBusy}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-500/10 text-teal-700 dark:text-teal-300">
              <TrendingUp className="h-4 w-4" />
            </div>
            <h2 id="financial-reporting-title" className="text-lg font-semibold">
              Financial reporting
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Revenue, spend, refunds, protocol fees, and Cardano fees from one server snapshot.
          </p>
          {summary && generatedAt && (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span>{transactionCountDisplay?.text}</span>
              {summary.totals.transactionCountCompleteness === 'partial' && (
                <Badge variant="warning">Partial count</Badge>
              )}
              <span>
                · {humanize(summary.metadata.filters.dateBasis)} · {summary.bucket} buckets ·{' '}
                {summary.metadata.filters.timeZone} · generated {generatedAt}
              </span>
            </div>
          )}
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
            onClick={() => model.exportZip()}
            disabled={model.isExporting || summary == null || model.body == null}
          >
            {model.isExporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {model.isExporting ? 'Preparing…' : 'Download ZIP'}
          </Button>
        </div>
      </div>

      <FinancialReportFilters
        form={model.form}
        isLoading={model.isLoadingFacets}
        managedWallets={model.managedWallets}
        paymentSources={model.paymentSources}
        snapshotPaymentSource={summary?.metadata.paymentSource ?? null}
        onSetPaymentSource={model.setPaymentSource}
        onToggleRole={model.toggleRole}
        onToggleState={model.toggleState}
        onToggleWallet={model.toggleWallet}
        onUpdate={model.updateForm}
      />

      <div className="min-h-6" aria-live="polite">
        {model.facetsError ? (
          <p className="text-sm text-destructive">{model.facetsError}</p>
        ) : model.isLoadingFacets ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading report filters…
          </p>
        ) : model.bodyError ? (
          <p className="text-sm text-destructive">{model.bodyError}</p>
        ) : model.summaryError ? (
          <p className="text-sm text-destructive">{model.summaryError}</p>
        ) : model.exportError ? (
          <p className="text-sm text-destructive">{model.exportError}</p>
        ) : isBusy ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Calculating financial report…
          </p>
        ) : model.paymentSources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No accessible payment source is available on this network.
          </p>
        ) : null}
      </div>

      {isBusy && !summary ? (
        <ReportLoadingState />
      ) : summary ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Accounting totals</h3>
              <p className="text-xs text-muted-foreground">
                Known values remain visible when historical fee allocation is partial.
              </p>
            </div>
            {assetUnits.length > 0 && (
              <div className="w-full space-y-1.5 sm:w-64">
                <label htmlFor="financial-report-asset" className="text-xs font-medium">
                  Business asset
                </label>
                <Select value={selectedUnit ?? undefined} onValueChange={setRequestedUnit}>
                  <SelectTrigger id="financial-report-asset">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assetUnits.map((unit) => {
                      const descriptor = getReportAssetDescriptor(summary, unit);
                      return (
                        <SelectItem key={unit} value={unit}>
                          {descriptor.symbol ?? shortenAddress(unit, 8)}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {transactionCountDisplay?.isConfirmedEmpty && (
            <Card className="border-dashed shadow-none">
              <CardContent className="py-8 text-center">
                <p className="font-medium">No matching transactions</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Change the period, wallet, role, state, or address filters.
                </p>
              </CardContent>
            </Card>
          )}

          <FinancialMetricCards
            summary={summary}
            roles={model.form.roles}
            selectedUnit={selectedUnit}
          />

          {summary.metadata.warnings.length > 0 && (
            <div
              id="financial-report-warnings"
              className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
            >
              <div className="mb-2 flex items-center gap-2">
                <Badge variant="warning">Partial data</Badge>
                <h3 className="text-sm font-semibold">Report warnings</h3>
              </div>
              <ul className="space-y-1 text-sm text-amber-900 dark:text-amber-100">
                {summary.metadata.warnings.map((warning, index) => (
                  <li key={`${warning.code}:${warning.rowId ?? ''}:${index}`}>{warning.message}</li>
                ))}
              </ul>
            </div>
          )}

          <FinancialHistoryCharts
            summary={summary}
            roles={model.form.roles}
            selectedUnit={selectedUnit}
          />

          <div>
            <div className="mb-3">
              <h3 className="text-sm font-semibold">Wallet and role breakdown</h3>
              <p className="text-xs text-muted-foreground">
                Each managed wallet keeps separate Buyer and Seller accounting rows.
              </p>
            </div>
            <FinancialWalletTable
              summary={summary}
              facets={{
                paymentSources: model.paymentSources,
                managedWallets: model.managedWallets,
              }}
              selectedUnit={selectedUnit}
              roles={model.form.roles}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
