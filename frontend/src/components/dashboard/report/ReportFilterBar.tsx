import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { GetReportsFacetsResponses } from '@/lib/api/generated';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
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
import { defaultCustomDateRange, formatCalendarDate } from '@/lib/date-picker-calendar';
import { cn, shortenAddress } from '@/lib/utils';
import {
  REPORT_BUCKET_LABELS,
  REPORT_DATE_BASIS_HINTS,
  REPORT_DATE_BASIS_LABELS,
  REPORT_DATE_PRESET_LABELS,
  REPORT_REVENUE_MODE_HINTS,
  REPORT_REVENUE_MODE_LABELS,
  humanizeReportValue,
} from '@/lib/transaction-report/report-labels';
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
import { FiatSettingsField } from '@/components/transactions/report-export/FiatSettingsField';
import {
  NO_FIAT_CURRENCY,
  type FiatIssue,
  type ReportFiatCapability,
} from '@/lib/transaction-report/fiat-settings';

type ReportFacets = GetReportsFacetsResponses[200]['data'];

type ReportFilterBarProps = Readonly<{
  form: TransactionReportFormState;
  isLoading: boolean;
  managedWallets: ReportFacets['managedWallets'];
  paymentSources: ReportFacets['paymentSources'];
  assetUnits: readonly string[];
  selectedUnit: string | null;
  assetLabel: (unit: string) => string;
  onSelectUnit: (unit: string) => void;
  onSetPaymentSource: (paymentSourceId: string) => void;
  onToggleRole: (role: ReportRole) => void;
  onToggleState: (state: ReportOnChainState) => void;
  onToggleWallet: (walletId: string) => void;
  onUpdate: (patch: Partial<TransactionReportFormState>) => void;
  fiatCapability: ReportFiatCapability | null;
  fiatIssue: FiatIssue | null;
}>;

function sourceLabel(source: ReportFacets['paymentSources'][number]): string {
  const version = source.paymentSourceType === 'Web3CardanoV2' ? 'Cardano V2' : 'Cardano V1';
  return `${version} · ${shortenAddress(source.smartContractAddress, 7)}${source.deletedAt ? ' · Archived' : ''}`;
}

function todayAsDateInput(): string {
  return formatCalendarDate(new Date());
}

/** Counts only the filters that are hidden behind "More filters". */
function countHiddenFilters(form: TransactionReportFormState): number {
  return (
    (form.managedWalletIds.length > 0 ? 1 : 0) +
    (form.states.length > 0 ? 1 : 0) +
    (form.externalAddressesText.trim() ? 1 : 0) +
    (form.dateBasis === 'RevenueRecognizedAt' ? 0 : 1) +
    (form.revenueMode === 'Billable' ? 0 : 1) +
    (form.bucket === 'Auto' ? 0 : 1) +
    (form.fiatCurrency === NO_FIAT_CURRENCY ? 0 : 1)
  );
}

function RoleToggle({
  role,
  isActive,
  onToggle,
}: Readonly<{ role: ReportRole; isActive: boolean; onToggle: () => void }>) {
  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={onToggle}
      className={cn(
        'h-9 rounded-md border px-3 text-sm transition-colors',
        isActive
          ? 'border-primary/40 bg-primary/10 text-foreground'
          : 'text-muted-foreground hover:bg-muted/50',
      )}
    >
      {role === 'Seller' ? 'Selling' : 'Buying'}
    </button>
  );
}

export function ReportFilterBar({
  form,
  isLoading,
  managedWallets,
  paymentSources,
  assetUnits,
  selectedUnit,
  assetLabel,
  onSelectUnit,
  onSetPaymentSource,
  onToggleRole,
  onToggleState,
  onToggleWallet,
  onUpdate,
  fiatCapability,
  fiatIssue,
}: ReportFilterBarProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hiddenFilterCount = countHiddenFilters(form);
  const maxDate = todayAsDateInput();

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 p-3">
        <Select
          value={form.datePreset}
          onValueChange={(value) => {
            const datePreset = value as ReportDatePreset;
            // An empty custom range shows no history at all, so the fields open
            // on the period the operator just left.
            const seeded =
              datePreset === 'custom' && (!form.customStartDate || !form.customEndDate)
                ? defaultCustomDateRange()
                : null;
            onUpdate({
              datePreset,
              ...(seeded == null
                ? {}
                : { customStartDate: seeded.start, customEndDate: seeded.end }),
            });
          }}
        >
          <SelectTrigger aria-label="Period" className="w-auto min-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(REPORT_DATE_PRESET_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {assetUnits.length > 0 && selectedUnit && (
          <Select value={selectedUnit} onValueChange={onSelectUnit}>
            <SelectTrigger aria-label="Currency" className="w-auto min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {assetUnits.map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {assetLabel(unit)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="flex gap-1" role="group" aria-label="Sides to include">
          {(['Seller', 'Buyer'] as const).map((role) => (
            <RoleToggle
              key={role}
              role={role}
              isActive={form.roles.includes(role)}
              onToggle={() => onToggleRole(role)}
            />
          ))}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((current) => !current)}
        >
          <SlidersHorizontal className="h-4 w-4" />
          More filters
          {hiddenFilterCount > 0 && (
            <span className="ml-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs">
              {hiddenFilterCount}
            </span>
          )}
        </Button>
      </div>

      {form.datePreset === 'custom' && (
        <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="report-start-date" className="text-xs">
              First day
            </Label>
            <DatePicker
              id="report-start-date"
              value={form.customStartDate}
              max={form.customEndDate || maxDate}
              onChange={(customStartDate) => onUpdate({ customStartDate })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-end-date" className="text-xs">
              Last day
            </Label>
            <DatePicker
              id="report-end-date"
              value={form.customEndDate}
              min={form.customStartDate || undefined}
              max={maxDate}
              onChange={(customEndDate) => onUpdate({ customEndDate })}
            />
          </div>
        </div>
      )}

      {isExpanded && (
        <div className="grid gap-5 border-t bg-muted/10 p-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="report-source">Payment source</Label>
            <Select
              value={form.paymentSourceId || undefined}
              onValueChange={onSetPaymentSource}
              disabled={isLoading || paymentSources.length === 0}
            >
              <SelectTrigger id="report-source">
                <SelectValue placeholder={isLoading ? 'Loading…' : 'Select a source'} />
              </SelectTrigger>
              <SelectContent>
                {paymentSources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {sourceLabel(source)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <FiatSettingsField
            currency={form.fiatCurrency}
            mode={form.fiatMode}
            capability={fiatCapability}
            issue={fiatIssue}
            onChange={onUpdate}
            idPrefix="dashboard"
            isPlain
          />

          <div className="space-y-1.5">
            <Label htmlFor="report-bucket">Group the history by</Label>
            <Select
              value={form.bucket}
              onValueChange={(value) => onUpdate({ bucket: value as ReportBucket })}
            >
              <SelectTrigger id="report-bucket">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(REPORT_BUCKET_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="report-date-basis">Count a payment by</Label>
            <Select
              value={form.dateBasis}
              onValueChange={(value) => onUpdate({ dateBasis: value as ReportDateBasis })}
            >
              <SelectTrigger id="report-date-basis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(REPORT_DATE_BASIS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {REPORT_DATE_BASIS_HINTS[form.dateBasis]}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="report-revenue-mode">Count revenue when it is</Label>
            <Select
              value={form.revenueMode}
              onValueChange={(value) => onUpdate({ revenueMode: value as ReportRevenueMode })}
            >
              <SelectTrigger id="report-revenue-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(REPORT_REVENUE_MODE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {REPORT_REVENUE_MODE_HINTS[form.revenueMode]}
            </p>
          </div>

          <fieldset className="relative space-y-1.5">
            <legend className="text-sm font-medium">Wallets</legend>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-0 top-0 h-auto px-1 py-0 text-xs"
              onClick={() => onUpdate({ managedWalletIds: [] })}
            >
              Use all
            </Button>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
              {managedWallets.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  This payment source has no wallets yet.
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
                      {wallet.note?.trim() || shortenAddress(wallet.walletAddress, 8)}
                    </span>
                    <span className="text-muted-foreground">
                      {wallet.type === 'Selling' ? 'Selling' : 'Buying'}
                      {wallet.deletedAt ? ' · Archived' : ''}
                    </span>
                  </label>
                ))
              )}
            </div>
          </fieldset>

          <fieldset className="relative space-y-1.5">
            <legend className="text-sm font-medium">Payment states</legend>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-0 top-0 h-auto px-1 py-0 text-xs"
              onClick={() => onUpdate({ states: [] })}
            >
              Use all
            </Button>
            <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded-md border p-2">
              {REPORT_ON_CHAIN_STATES.map((state) => (
                <label
                  key={state}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                >
                  <Checkbox
                    checked={form.states.includes(state)}
                    onCheckedChange={() => onToggleState(state)}
                  />
                  <span>{humanizeReportValue(state)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="report-addresses">Only these addresses</Label>
            <Textarea
              id="report-addresses"
              className="min-h-16 font-mono text-xs"
              placeholder="Optional. One address per line."
              value={form.externalAddressesText}
              onChange={(event) => onUpdate({ externalAddressesText: event.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">
              Matches the other side, the payout, and the return address.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="report-time-zone">Time zone</Label>
            <Input
              id="report-time-zone"
              list="report-time-zones"
              value={form.timeZone}
              onChange={(event) => onUpdate({ timeZone: event.target.value })}
              placeholder="Europe/Prague"
            />
            <datalist id="report-time-zones">
              <option value="Etc/UTC" />
              <option value={form.timeZone} />
            </datalist>
            <p className="text-[11px] text-muted-foreground">
              Days and weeks start and end in this zone.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
