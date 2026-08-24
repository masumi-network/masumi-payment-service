import { Download, FileArchive, FileSpreadsheet, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn, shortenAddress } from '@/lib/utils';
import type { ReportExportKind } from '@/lib/transaction-report/download';
import { getReportTransactionCountDisplay } from '@/lib/transaction-report/dashboard-metrics';
import {
  REPORT_ON_CHAIN_STATES,
  type ReportDateBasis,
  type ReportDatePreset,
  type ReportRevenueMode,
  type TransactionReportViewDefaults,
} from './download-details.helpers';
import { useDownloadDetailsModel } from './useDownloadDetailsModel';

type DownloadDetailsDialogProps = Readonly<{
  open: boolean;
  onClose: () => void;
  viewDefaults: TransactionReportViewDefaults;
}>;

const DATE_PRESETS: ReadonlyArray<{ value: ReportDatePreset; label: string }> = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom dates' },
];

const DATE_BASES: ReadonlyArray<{ value: ReportDateBasis; label: string; detail: string }> = [
  { value: 'RevenueRecognizedAt', label: 'Revenue recognized', detail: 'Economic events' },
  { value: 'FundsLockedAt', label: 'Funds locked', detail: 'Escrow cohort' },
  { value: 'CreatedAt', label: 'Request created', detail: 'Request cohort' },
];

const REVENUE_MODES: ReadonlyArray<{
  value: ReportRevenueMode;
  label: string;
  detail: string;
}> = [
  { value: 'Billable', label: 'Billable', detail: 'Earned after unlock' },
  { value: 'CashReceived', label: 'Cash received', detail: 'Withdrawn payouts' },
  { value: 'RequestedGross', label: 'Requested gross', detail: 'All requested value' },
];

const EXPORT_KINDS: ReadonlyArray<{
  value: ReportExportKind;
  label: string;
  detail: string;
}> = [
  {
    value: 'transactions',
    label: 'Transactions CSV',
    detail: 'One buyer or seller row per request',
  },
  {
    value: 'wallet-summary',
    label: 'Wallet summary CSV',
    detail: 'Totals by managed wallet and role',
  },
  { value: 'totals', label: 'Totals CSV', detail: 'One payment source total' },
  { value: 'zip', label: 'Complete ZIP', detail: 'All three CSV files from one snapshot' },
];

function humanize(value: string): string {
  return value.replace(/([A-Z])/g, ' $1').trim();
}

function todayAsDateInput(): string {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${today.getFullYear()}-${month}-${day}`;
}

export function DownloadDetailsDialog({ open, onClose, viewDefaults }: DownloadDetailsDialogProps) {
  const model = useDownloadDetailsModel({ open, onClose, viewDefaults });
  const previewCountDisplay = model.preview
    ? getReportTransactionCountDisplay(
        model.preview.totals.transactionCount,
        model.preview.totals.transactionCountCompleteness,
        'filtered transaction',
      )
    : null;
  const selectedExport = EXPORT_KINDS.find((option) => option.value === model.exportKind);
  const selectedSource = model.paymentSources.find(
    (source) => source.id === model.form.paymentSourceId,
  );
  const maxDate = todayAsDateInput();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent size="xl" className="gap-0 p-0">
        <div className="border-b bg-muted/20 px-6 pb-5 pt-9">
          <DialogHeader>
            <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              <FileSpreadsheet className="h-3.5 w-3.5" />
              Financial reporting
            </div>
            <DialogTitle className="text-xl">Export transaction report</DialogTitle>
            <DialogDescription>
              Export revenue, spend, refunds, protocol fees, and Cardano fees from one payment
              source.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="grid gap-6 px-6 py-5 lg:grid-cols-2">
          <section className="space-y-5" aria-labelledby="report-scope-heading">
            <div>
              <h3 id="report-scope-heading" className="text-sm font-semibold">
                Report scope
              </h3>
              <p className="text-xs text-muted-foreground">Choose source, period, and wallets.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="report-payment-source">Payment source</Label>
              <Select
                value={model.form.paymentSourceId || undefined}
                onValueChange={model.setPaymentSource}
                disabled={model.isLoadingFacets || model.paymentSources.length === 0}
              >
                <SelectTrigger id="report-payment-source">
                  <SelectValue
                    placeholder={model.isLoadingFacets ? 'Loading sources…' : 'Select a source'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {model.paymentSources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.paymentSourceType === 'Web3CardanoV2' ? 'Cardano V2' : 'Cardano V1'} ·{' '}
                      {shortenAddress(source.smartContractAddress, 7)}
                      {source.deletedAt ? ' · Archived' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedSource && (
                <p className="font-mono text-[11px] text-muted-foreground">
                  {selectedSource.network} · fee rate {selectedSource.feeRatePermille / 10}%
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="report-date-preset">Period</Label>
              <Select
                value={model.form.datePreset}
                onValueChange={(value) =>
                  model.updateForm({ datePreset: value as ReportDatePreset })
                }
              >
                <SelectTrigger id="report-date-preset">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATE_PRESETS.map((preset) => (
                    <SelectItem key={preset.value} value={preset.value}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {model.form.datePreset === 'custom' && (
                <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/10 p-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="report-start-date" className="text-xs">
                      First day
                    </Label>
                    <Input
                      id="report-start-date"
                      type="date"
                      max={maxDate}
                      value={model.form.customStartDate}
                      onChange={(event) =>
                        model.updateForm({ customStartDate: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="report-end-date" className="text-xs">
                      Last day
                    </Label>
                    <Input
                      id="report-end-date"
                      type="date"
                      max={maxDate}
                      value={model.form.customEndDate}
                      onChange={(event) => model.updateForm({ customEndDate: event.target.value })}
                    />
                  </div>
                </div>
              )}
            </div>

            <fieldset className="relative space-y-2">
              <legend className="text-sm font-medium">Managed wallets</legend>
              <button
                type="button"
                className="absolute right-0 top-0 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => model.updateForm({ managedWalletIds: [] })}
              >
                All wallets
              </button>
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border p-2">
                {model.managedWallets.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-muted-foreground">
                    No managed wallets belong to this source.
                  </p>
                ) : (
                  model.managedWallets.map((wallet) => (
                    <label
                      key={wallet.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={model.form.managedWalletIds.includes(wallet.id)}
                        onCheckedChange={() => model.toggleWallet(wallet.id)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {wallet.note?.trim()
                          ? `${wallet.note.trim()} (${shortenAddress(wallet.walletAddress, 8)})`
                          : shortenAddress(wallet.walletAddress, 8)}{' '}
                        · ID {shortenAddress(wallet.id, 5)}
                      </span>
                      <span className="text-muted-foreground">
                        {wallet.type === 'Selling' ? 'Seller' : 'Buyer'}
                        {wallet.deletedAt ? ' · Archived' : ''}
                      </span>
                    </label>
                  ))
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {model.form.managedWalletIds.length === 0
                  ? 'All accessible wallets are included.'
                  : `${model.form.managedWalletIds.length} wallet${model.form.managedWalletIds.length === 1 ? '' : 's'} selected.`}
              </p>
            </fieldset>
          </section>

          <section className="space-y-5" aria-labelledby="report-accounting-heading">
            <div>
              <h3 id="report-accounting-heading" className="text-sm font-semibold">
                Accounting rules
              </h3>
              <p className="text-xs text-muted-foreground">
                Set role, event date, and revenue rule.
              </p>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Role</legend>
              <div className="grid grid-cols-2 gap-2">
                {(['Seller', 'Buyer'] as const).map((role) => (
                  <label
                    key={role}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-md border p-3 transition-colors',
                      model.form.roles.includes(role) && 'border-foreground/40 bg-muted/30',
                    )}
                  >
                    <Checkbox
                      checked={model.form.roles.includes(role)}
                      onCheckedChange={() => model.toggleRole(role)}
                    />
                    <span>
                      <span className="block text-sm font-medium">{role}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {role === 'Seller' ? 'Payment requests' : 'Purchase requests'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="report-date-basis">Date basis</Label>
                <Select
                  value={model.form.dateBasis}
                  onValueChange={(value) =>
                    model.updateForm({ dateBasis: value as ReportDateBasis })
                  }
                >
                  <SelectTrigger id="report-date-basis">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATE_BASES.map((basis) => (
                      <SelectItem key={basis.value} value={basis.value}>
                        <span>{basis.label}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{basis.detail}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="report-revenue-mode">Revenue mode</Label>
                <Select
                  value={model.form.revenueMode}
                  onValueChange={(value) =>
                    model.updateForm({ revenueMode: value as ReportRevenueMode })
                  }
                >
                  <SelectTrigger id="report-revenue-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REVENUE_MODES.map((mode) => (
                      <SelectItem key={mode.value} value={mode.value}>
                        <span>{mode.label}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{mode.detail}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <fieldset className="relative space-y-2">
              <legend className="text-sm font-medium">States</legend>
              <button
                type="button"
                className="absolute right-0 top-0 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => model.updateForm({ states: [] })}
              >
                All states
              </button>
              <div className="grid max-h-36 grid-cols-2 gap-1 overflow-y-auto rounded-md border p-2">
                {REPORT_ON_CHAIN_STATES.map((state) => (
                  <label
                    key={state}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={model.form.states.includes(state)}
                      onCheckedChange={() => model.toggleState(state)}
                    />
                    <span>{humanize(state)}</span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {model.form.states.length === 0
                  ? 'All on-chain states are included.'
                  : `${model.form.states.length} state${model.form.states.length === 1 ? '' : 's'} selected.`}
              </p>
            </fieldset>

            <div className="space-y-2">
              <Label htmlFor="report-external-addresses">External addresses</Label>
              <Textarea
                id="report-external-addresses"
                className="min-h-16 font-mono text-xs"
                placeholder="Optional. Separate addresses with commas or new lines."
                value={model.form.externalAddressesText}
                onChange={(event) =>
                  model.updateForm({ externalAddressesText: event.target.value })
                }
              />
              <p className="text-[11px] text-muted-foreground">
                Matches counterparty, payout, and return addresses. Time zone: {model.form.timeZone}
                .
              </p>
            </div>
          </section>
        </div>

        <div className="border-t bg-muted/15 px-6 py-4">
          {viewDefaults.hasUnmappedFilters && (
            <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              Search, error type, and manual-action filters do not apply to financial reports.
              Source, role, and state filters shown here do apply.
            </p>
          )}

          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-h-10" aria-live="polite">
              {model.facetsError ? (
                <p className="text-sm text-destructive">{model.facetsError}</p>
              ) : model.isLoadingFacets ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading report filters…
                </p>
              ) : model.bodyError ? (
                <p className="text-sm text-destructive">{model.bodyError}</p>
              ) : model.previewError ? (
                <p className="text-sm text-destructive">{model.previewError}</p>
              ) : model.isPreviewLoading ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Calculating filtered totals…
                </p>
              ) : model.preview ? (
                <div>
                  <p className="text-sm font-medium">{previewCountDisplay?.text}</p>
                  <p className="text-xs text-muted-foreground">
                    {model.preview.metadata.warnings.length > 0
                      ? `${model.preview.metadata.warnings.length} completeness warning${model.preview.metadata.warnings.length === 1 ? '' : 's'} will be included.`
                      : 'One server snapshot will drive every exported value.'}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Select a payment source to preview.</p>
              )}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={model.reset}
                disabled={model.isDownloading}
              >
                <RotateCcw className="h-4 w-4" /> Reset
              </Button>
              <div className="min-w-64 space-y-1.5">
                <Label htmlFor="report-export-kind" className="text-xs">
                  File
                </Label>
                <Select
                  value={model.exportKind}
                  onValueChange={(value) => model.setExportKind(value as ReportExportKind)}
                >
                  <SelectTrigger id="report-export-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPORT_KINDS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">{selectedExport?.detail}</p>
              </div>
              <Button
                className="sm:mb-5"
                onClick={() => model.download()}
                disabled={
                  model.isDownloading ||
                  model.bodyError != null ||
                  model.facetsError != null ||
                  model.paymentSources.length === 0
                }
              >
                {model.isDownloading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : model.exportKind === 'zip' ? (
                  <FileArchive className="h-4 w-4" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {model.isDownloading ? 'Preparing…' : 'Download'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
