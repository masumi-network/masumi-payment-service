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
import { AddressListField } from '@/components/transactions/report-export/AddressListField';
import { PaymentStatesHint } from '@/components/transactions/report-export/PaymentStatesHint';
import { knownAddressesFromWallets } from '@/components/transactions/report-export/address-filter';
import { FiatSettingsField } from '@/components/transactions/report-export/FiatSettingsField';
import {
  NO_FIAT_CURRENCY,
  type FiatIssue,
  type ReportFiatCapability,
} from '@/lib/transaction-report/fiat-settings';

type ReportFacets = GetReportsFacetsResponses[200]['data'];

type ReportFilterBarProps = Readonly<{
  form: TransactionReportFormState;
  managedWallets: ReportFacets['managedWallets'];
  assetUnits: readonly string[];
  selectedUnit: string | null;
  assetLabel: (unit: string) => string;
  onSelectUnit: (unit: string) => void;
  onToggleRole: (role: ReportRole) => void;
  onToggleState: (state: ReportOnChainState) => void;
  onToggleWallet: (walletId: string) => void;
  onUpdate: (patch: Partial<TransactionReportFormState>) => void;
  fiatCapability: ReportFiatCapability | null;
  fiatIssue: FiatIssue | null;
}>;

function todayAsDateInput(): string {
  return formatCalendarDate(new Date());
}

type FilterGroup = 'rules' | 'currency' | 'scope';

/**
 * How many settings each group holds that are not on their default.
 *
 * The count is what makes hiding a group safe: a reader can see that something
 * is narrowing the report without having to open every panel to find it.
 */
function countGroupChanges(form: TransactionReportFormState, group: FilterGroup): number {
  if (group === 'rules') {
    return (
      (form.dateBasis === 'RevenueRecognizedAt' ? 0 : 1) +
      (form.revenueMode === 'Billable' ? 0 : 1) +
      (form.bucket === 'Auto' ? 0 : 1)
    );
  }
  if (group === 'currency') return form.fiatCurrency === NO_FIAT_CURRENCY ? 0 : 1;
  return (
    (form.managedWalletIds.length > 0 ? 1 : 0) +
    (form.states.length > 0 ? 1 : 0) +
    (form.externalAddressesText.trim() ? 1 : 0)
  );
}

const FILTER_GROUPS: ReadonlyArray<Readonly<{ value: FilterGroup; label: string }>> = [
  { value: 'scope', label: 'Include' },
  { value: 'rules', label: 'Rules' },
  { value: 'currency', label: 'Currency' },
];

/** Keeps a group heading and its reset control from colliding in a narrow column. */
function FieldHeader({
  title,
  action,
  hint,
}: Readonly<{ title: string; action: React.ReactNode; hint?: React.ReactNode }>) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <span className="flex items-center gap-1 text-sm font-medium">
        {title}
        {hint}
      </span>
      {action}
    </div>
  );
}

function ResetFieldButton({ onClick }: Readonly<{ onClick: () => void }>) {
  return (
    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onClick}>
      Use all
    </Button>
  );
}

function GroupButton({
  label,
  count,
  isOpen,
  onClick,
}: Readonly<{ label: string; count: number; isOpen: boolean; onClick: () => void }>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={isOpen}
      onClick={onClick}
      className={isOpen ? 'bg-muted' : undefined}
    >
      {label}
      {count > 0 && (
        <span className="ml-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs">
          {count}
        </span>
      )}
    </Button>
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
  managedWallets,
  assetUnits,
  selectedUnit,
  assetLabel,
  onSelectUnit,
  onToggleRole,
  onToggleState,
  onToggleWallet,
  onUpdate,
  fiatCapability,
  fiatIssue,
}: ReportFilterBarProps) {
  const [openGroup, setOpenGroup] = useState<FilterGroup | null>(null);
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

        <div className="ml-auto flex items-center gap-0.5" role="group" aria-label="Filter groups">
          <SlidersHorizontal className="mr-1 h-4 w-4 text-muted-foreground" />
          {FILTER_GROUPS.map((group) => (
            <GroupButton
              key={group.value}
              label={group.label}
              count={countGroupChanges(form, group.value)}
              isOpen={openGroup === group.value}
              onClick={() =>
                setOpenGroup((current) => (current === group.value ? null : group.value))
              }
            />
          ))}
        </div>
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

      {openGroup === 'rules' && (
        <div className="grid gap-5 border-t bg-muted/10 p-4 lg:grid-cols-3">
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

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
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
        </div>
      )}

      {openGroup === 'currency' && (
        <div className="border-t bg-muted/10 p-4">
          <div className="max-w-xl">
            <FiatSettingsField
              currency={form.fiatCurrency}
              mode={form.fiatMode}
              capability={fiatCapability}
              issue={fiatIssue}
              onChange={onUpdate}
              idPrefix="dashboard"
              isPlain
            />
          </div>
        </div>
      )}

      {openGroup === 'scope' && (
        <div className="grid gap-5 border-t bg-muted/10 p-4 lg:grid-cols-3">
          <fieldset className="space-y-1.5">
            <legend className="sr-only">Wallets</legend>
            <FieldHeader
              title="Wallets"
              action={
                form.managedWalletIds.length > 0 ? (
                  <ResetFieldButton onClick={() => onUpdate({ managedWalletIds: [] })} />
                ) : (
                  <span className="text-[11px] text-muted-foreground">All wallets</span>
                )
              }
            />
            <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
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
                    <span className="shrink-0 text-muted-foreground">
                      {wallet.type === 'Selling' ? 'Selling' : 'Buying'}
                      {wallet.deletedAt ? ' \u00b7 Archived' : ''}
                    </span>
                  </label>
                ))
              )}
            </div>
          </fieldset>

          <fieldset className="space-y-1.5">
            <legend className="sr-only">Payment states</legend>
            <FieldHeader
              title="Payment states"
              hint={<PaymentStatesHint />}
              action={
                form.states.length > 0 ? (
                  <ResetFieldButton onClick={() => onUpdate({ states: [] })} />
                ) : (
                  <span className="text-[11px] text-muted-foreground">All states</span>
                )
              }
            />
            <div className="grid max-h-40 gap-0.5 overflow-y-auto rounded-md border p-1.5">
              {REPORT_ON_CHAIN_STATES.map((state) => (
                <label
                  key={state}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                >
                  <Checkbox
                    checked={form.states.includes(state)}
                    onCheckedChange={() => onToggleState(state)}
                  />
                  <span className="min-w-0">{humanizeReportValue(state)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <AddressListField
            value={form.externalAddressesText}
            onChange={(externalAddressesText) => onUpdate({ externalAddressesText })}
            knownAddresses={knownAddressesFromWallets(managedWallets)}
            idPrefix="dashboard"
          />
        </div>
      )}
    </div>
  );
}
