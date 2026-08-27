import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
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
  REPORT_DATE_PRESET_LABELS,
  humanizeReportValue,
} from '@/lib/transaction-report/report-labels';
import {
  REPORT_ON_CHAIN_STATES,
  isFinalReportState,
  type ReportDatePreset,
  type ReportRole,
} from '../download-details.helpers';
import type { useDownloadDetailsModel } from '../useDownloadDetailsModel';
import { AddressListField } from './AddressListField';
import { PaymentStatesHint } from './PaymentStatesHint';
import { knownAddressesFromWallets } from './address-filter';
import { reportPurposeShows } from './report-purposes';

type ReportModel = ReturnType<typeof useDownloadDetailsModel>;

function todayAsDateInput(): string {
  return formatCalendarDate(new Date());
}

function FieldHeader({
  title,
  action,
  hint,
}: Readonly<{ title: string; action?: ReactNode; hint?: ReactNode }>) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-2">
      <span className="flex items-center gap-1 text-sm font-medium">
        {title}
        {hint}
      </span>
      {action}
    </div>
  );
}

/**
 * A checked row that stands for "no filter at all".
 *
 * A list of empty checkboxes reads as "nothing is included", when an empty
 * filter in fact includes everything.
 */
function IncludeAllRow({
  label,
  isActive,
  onSelect,
}: Readonly<{ label: string; isActive: boolean; onSelect: () => void }>) {
  return (
    <label className="mb-0.5 flex cursor-pointer items-center gap-2 rounded border-b px-2 py-1.5 text-xs hover:bg-muted/50">
      <Checkbox checked={isActive} onCheckedChange={onSelect} />
      <span className="font-medium">{label}</span>
    </label>
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
        'flex-1 rounded-md border px-3 py-2 text-left transition-colors',
        isActive ? 'border-primary/40 bg-primary/10' : 'text-muted-foreground hover:bg-muted/50',
      )}
    >
      <span className="block text-sm font-medium text-foreground">
        {role === 'Seller' ? 'Selling' : 'Buying'}
      </span>
      <span className="block text-[11px] leading-tight">
        {role === 'Seller' ? 'Payment requests you fulfil' : 'Purchase requests you pay for'}
      </span>
    </button>
  );
}

/** Period, sides, and the filters the chosen flow puts on screen. */
export function ReportScopeFields({ model }: Readonly<{ model: ReportModel }>) {
  const maxDate = todayAsDateInput();

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="report-date-preset">Period</Label>
        <Select
          value={model.form.datePreset}
          onValueChange={(value) => {
            const datePreset = value as ReportDatePreset;
            // An empty custom range only produces an error message, so the
            // fields open on the period the operator just left.
            const shouldSeedRange =
              datePreset === 'custom' && (!model.form.customStartDate || !model.form.customEndDate);
            const seeded = shouldSeedRange ? defaultCustomDateRange() : null;
            model.updateForm({
              datePreset,
              ...(seeded == null
                ? {}
                : { customStartDate: seeded.start, customEndDate: seeded.end }),
            });
          }}
        >
          <SelectTrigger id="report-date-preset">
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
        {model.form.datePreset === 'custom' && (
          <div className="grid gap-3 rounded-md border bg-muted/10 p-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="report-start-date" className="text-xs">
                First day
              </Label>
              <DatePicker
                id="report-start-date"
                value={model.form.customStartDate}
                max={model.form.customEndDate || maxDate}
                onChange={(customStartDate) => model.updateForm({ customStartDate })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="report-end-date" className="text-xs">
                Last day
              </Label>
              <DatePicker
                id="report-end-date"
                value={model.form.customEndDate}
                min={model.form.customStartDate || undefined}
                max={maxDate}
                onChange={(customEndDate) => model.updateForm({ customEndDate })}
              />
            </div>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Days start and end in {model.form.timeZone}.
        </p>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="sr-only">Sides to include</legend>
        <FieldHeader title="Sides" />
        <div className="flex gap-2">
          {(['Seller', 'Buyer'] as const).map((role) => (
            <RoleToggle
              key={role}
              role={role}
              isActive={model.form.roles.includes(role)}
              onToggle={() => model.toggleRole(role)}
            />
          ))}
        </div>
      </fieldset>

      {reportPurposeShows(model.purpose, 'wallets') && (
        <fieldset className="space-y-1.5">
          <legend className="sr-only">Wallets</legend>
          <FieldHeader
            title="Wallets"
            action={
              model.form.managedWalletIds.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => model.updateForm({ managedWalletIds: [] })}
                >
                  Use all
                </Button>
              ) : null
            }
          />
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
            <IncludeAllRow
              label="Every wallet"
              isActive={model.form.managedWalletIds.length === 0}
              onSelect={() => model.updateForm({ managedWalletIds: [] })}
            />
            {model.managedWallets.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                This payment source has no wallets yet.
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
                    {wallet.note?.trim() || shortenAddress(wallet.walletAddress, 8)}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {wallet.type === 'Selling' ? 'Selling' : 'Buying'}
                    {wallet.deletedAt ? ' · Archived' : ''}
                  </span>
                </label>
              ))
            )}
          </div>
        </fieldset>
      )}

      {reportPurposeShows(model.purpose, 'states') && (
        <fieldset className="space-y-1.5">
          <legend className="sr-only">Payment states</legend>
          <FieldHeader
            title="Payment states"
            hint={<PaymentStatesHint />}
            action={
              model.form.states.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => model.updateForm({ states: [] })}
                >
                  Use all
                </Button>
              ) : null
            }
          />
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
            <IncludeAllRow
              label="Every state"
              isActive={model.form.states.length === 0}
              onSelect={() => model.updateForm({ states: [] })}
            />
            {REPORT_ON_CHAIN_STATES.map((state) => (
              <label
                key={state}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
              >
                <Checkbox
                  checked={model.form.states.includes(state)}
                  onCheckedChange={() => model.toggleState(state)}
                />
                <span className="min-w-0 flex-1">{humanizeReportValue(state)}</span>
                {isFinalReportState(state) && (
                  <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Final
                  </span>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {reportPurposeShows(model.purpose, 'addresses') && (
        <AddressListField
          value={model.form.externalAddressesText}
          onChange={(externalAddressesText) => model.updateForm({ externalAddressesText })}
          knownAddresses={knownAddressesFromWallets(model.managedWallets)}
        />
      )}
    </div>
  );
}
