import type { GetReportsFacetsResponses, PostReportsSummaryResponses } from '@/lib/api/generated';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  REPORT_ON_CHAIN_STATES,
  type ReportBucket,
  type ReportDateBasis,
  type ReportDatePreset,
  type ReportOnChainState,
  type ReportRevenueMode,
  type ReportRole,
  type TransactionReportFormState,
} from '@/components/transactions/download-details.helpers';

type ReportFacets = GetReportsFacetsResponses[200]['data'];
type ReportPaymentSourceSnapshot =
  PostReportsSummaryResponses[200]['data']['metadata']['paymentSource'];

type FinancialReportFiltersProps = Readonly<{
  form: TransactionReportFormState;
  isLoading: boolean;
  managedWallets: ReportFacets['managedWallets'];
  paymentSources: ReportFacets['paymentSources'];
  snapshotPaymentSource: ReportPaymentSourceSnapshot | null;
  onSetPaymentSource: (paymentSourceId: string) => void;
  onToggleRole: (role: ReportRole) => void;
  onToggleState: (state: ReportOnChainState) => void;
  onToggleWallet: (walletId: string) => void;
  onUpdate: (patch: Partial<TransactionReportFormState>) => void;
}>;

const DATE_PRESETS: ReadonlyArray<{ value: ReportDatePreset; label: string }> = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom dates' },
];

const DATE_BASES: ReadonlyArray<{ value: ReportDateBasis; label: string }> = [
  { value: 'RevenueRecognizedAt', label: 'Revenue recognized' },
  { value: 'FundsLockedAt', label: 'Funds locked' },
  { value: 'CreatedAt', label: 'Request created' },
];

const REVENUE_MODES: ReadonlyArray<{ value: ReportRevenueMode; label: string }> = [
  { value: 'Billable', label: 'Billable' },
  { value: 'CashReceived', label: 'Cash received' },
  { value: 'RequestedGross', label: 'Requested gross' },
];

const REPORT_BUCKETS: ReadonlyArray<{ value: ReportBucket; label: string }> = [
  { value: 'Auto', label: 'Automatic buckets' },
  { value: 'Day', label: 'Daily' },
  { value: 'Week', label: 'Weekly' },
  { value: 'Month', label: 'Monthly' },
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

export function FinancialReportFilters({
  form,
  isLoading,
  managedWallets,
  paymentSources,
  snapshotPaymentSource,
  onSetPaymentSource,
  onToggleRole,
  onToggleState,
  onToggleWallet,
  onUpdate,
}: FinancialReportFiltersProps) {
  const selectedSource = paymentSources.find((source) => source.id === form.paymentSourceId);
  const provenanceSource =
    snapshotPaymentSource?.id === form.paymentSourceId ? snapshotPaymentSource : selectedSource;
  const maxDate = todayAsDateInput();

  return (
    <div className="space-y-4 rounded-lg border bg-muted/10 p-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <div className="space-y-1.5 md:col-span-2 xl:col-span-1">
          <Label htmlFor="dashboard-report-source">Payment source</Label>
          <Select
            value={form.paymentSourceId || undefined}
            onValueChange={onSetPaymentSource}
            disabled={isLoading || paymentSources.length === 0}
          >
            <SelectTrigger id="dashboard-report-source">
              <SelectValue placeholder={isLoading ? 'Loading sources…' : 'Select a source'} />
            </SelectTrigger>
            <SelectContent>
              {paymentSources.map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  {source.paymentSourceType === 'Web3CardanoV2' ? 'Cardano V2' : 'Cardano V1'} ·{' '}
                  {shortenAddress(source.smartContractAddress, 7)}
                  {source.deletedAt ? ' · Archived' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {provenanceSource && (
            <p className="font-mono text-[11px] text-muted-foreground">
              {snapshotPaymentSource?.id === form.paymentSourceId ? 'Report snapshot' : 'Source'} ·{' '}
              {provenanceSource.paymentSourceType === 'Web3CardanoV2' ? 'Cardano V2' : 'Cardano V1'}{' '}
              · {provenanceSource.network} · fee rate {provenanceSource.feeRatePermille / 10}%
              {provenanceSource.deletedAt ? ' · Archived' : ''}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dashboard-report-period">Period</Label>
          <Select
            value={form.datePreset}
            onValueChange={(value) => onUpdate({ datePreset: value as ReportDatePreset })}
          >
            <SelectTrigger id="dashboard-report-period">
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
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dashboard-report-date-basis">Date basis</Label>
          <Select
            value={form.dateBasis}
            onValueChange={(value) => onUpdate({ dateBasis: value as ReportDateBasis })}
          >
            <SelectTrigger id="dashboard-report-date-basis">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_BASES.map((basis) => (
                <SelectItem key={basis.value} value={basis.value}>
                  {basis.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dashboard-report-revenue-mode">Revenue mode</Label>
          <Select
            value={form.revenueMode}
            onValueChange={(value) => onUpdate({ revenueMode: value as ReportRevenueMode })}
          >
            <SelectTrigger id="dashboard-report-revenue-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REVENUE_MODES.map((mode) => (
                <SelectItem key={mode.value} value={mode.value}>
                  {mode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dashboard-report-bucket">History buckets</Label>
          <Select
            value={form.bucket}
            onValueChange={(value) => onUpdate({ bucket: value as ReportBucket })}
          >
            <SelectTrigger id="dashboard-report-bucket">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORT_BUCKETS.map((bucket) => (
                <SelectItem key={bucket.value} value={bucket.value}>
                  {bucket.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {form.datePreset === 'custom' && (
        <div className="grid gap-3 rounded-md border bg-background p-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="dashboard-report-start-date" className="text-xs">
              First day
            </Label>
            <Input
              id="dashboard-report-start-date"
              type="date"
              max={maxDate}
              value={form.customStartDate}
              onChange={(event) => onUpdate({ customStartDate: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dashboard-report-end-date" className="text-xs">
              Last day
            </Label>
            <Input
              id="dashboard-report-end-date"
              type="date"
              max={maxDate}
              value={form.customEndDate}
              onChange={(event) => onUpdate({ customEndDate: event.target.value })}
            />
          </div>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Roles</legend>
        <div className="flex flex-wrap gap-2">
          {(['Seller', 'Buyer'] as const).map((role) => (
            <label
              key={role}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm',
                form.roles.includes(role) && 'border-foreground/40 bg-background',
              )}
            >
              <Checkbox
                checked={form.roles.includes(role)}
                onCheckedChange={() => onToggleRole(role)}
              />
              {role}
            </label>
          ))}
        </div>
      </fieldset>

      <details className="group rounded-md border bg-background">
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
          Wallet, state, and address filters
          <span className="ml-2 font-normal text-muted-foreground">
            {form.managedWalletIds.length > 0
              ? `${form.managedWalletIds.length} wallets`
              : 'All wallets'}
            {' · '}
            {form.states.length > 0 ? `${form.states.length} states` : 'All states'}
            {' · '}
            {form.externalAddressesText.trim() ? 'Address filter active' : 'All addresses'}
          </span>
        </summary>
        <div className="grid gap-5 border-t p-4 lg:grid-cols-2">
          <fieldset className="relative space-y-2">
            <legend className="text-sm font-medium">Managed wallets</legend>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-0 top-0 h-auto px-1 py-0 text-xs"
              onClick={() => onUpdate({ managedWalletIds: [] })}
            >
              All wallets
            </Button>
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2">
              {managedWallets.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  No managed wallets belong to this source.
                </p>
              ) : (
                managedWallets.map((wallet) => (
                  <label
                    key={wallet.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={form.managedWalletIds.includes(wallet.id)}
                      onCheckedChange={() => onToggleWallet(wallet.id)}
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
          </fieldset>

          <fieldset className="relative space-y-2">
            <legend className="text-sm font-medium">States</legend>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-0 top-0 h-auto px-1 py-0 text-xs"
              onClick={() => onUpdate({ states: [] })}
            >
              All states
            </Button>
            <div className="grid max-h-44 grid-cols-2 gap-1 overflow-y-auto rounded-md border p-2">
              {REPORT_ON_CHAIN_STATES.map((state) => (
                <label
                  key={state}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                >
                  <Checkbox
                    checked={form.states.includes(state)}
                    onCheckedChange={() => onToggleState(state)}
                  />
                  <span>{humanize(state)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="dashboard-report-addresses">External addresses</Label>
            <Textarea
              id="dashboard-report-addresses"
              className="min-h-16 font-mono text-xs"
              placeholder="Optional. Separate addresses with commas or new lines."
              value={form.externalAddressesText}
              onChange={(event) => onUpdate({ externalAddressesText: event.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">
              Matches counterparty, payout, and return addresses.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="dashboard-report-time-zone">IANA time zone</Label>
            <Input
              id="dashboard-report-time-zone"
              list="dashboard-report-time-zones"
              value={form.timeZone}
              onChange={(event) => onUpdate({ timeZone: event.target.value })}
              placeholder="Europe/Prague"
            />
            <datalist id="dashboard-report-time-zones">
              <option value="Etc/UTC" />
              <option value={form.timeZone} />
            </datalist>
            <p className="text-[11px] text-muted-foreground">
              Bucket boundaries and labels use this time zone.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
