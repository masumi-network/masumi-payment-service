import { AlertTriangle, Coins } from 'lucide-react';
import { InfoHint } from '@/components/ui/info-hint';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  NO_FIAT_CURRENCY,
  REPORT_FIAT_MODE_OPTIONS,
  availableFiatCurrencies,
  isReportFiatCurrency,
  type FiatIssue,
  type ReportFiatCapability,
  type ReportFiatCurrencyChoice,
  type ReportFiatMode,
} from '@/lib/transaction-report/fiat-settings';

export type FiatSettingsFieldProps = Readonly<{
  currency: ReportFiatCurrencyChoice;
  mode: ReportFiatMode;
  capability: ReportFiatCapability | null;
  issue: FiatIssue | null;
  onChange: (
    patch: Readonly<{ fiatCurrency?: ReportFiatCurrencyChoice; fiatMode?: ReportFiatMode }>,
  ) => void;
  /** Ids stay unique when both the dashboard and the export dialog are mounted. */
  idPrefix?: string;
  /** Drops the surrounding card, for use inside a panel that already has one. */
  isPlain?: boolean;
}>;

/**
 * Turns the report's crypto figures into one currency an accountant can book.
 *
 * The block stays visible when no key is set up, because a hidden option reads
 * as a missing feature rather than a setting somebody has to switch on.
 */
export function FiatSettingsField({
  currency,
  mode,
  capability,
  issue,
  onChange,
  idPrefix = 'report',
  isPlain = false,
}: FiatSettingsFieldProps) {
  const currencies = availableFiatCurrencies(capability);
  const isOn = currency !== NO_FIAT_CURRENCY;
  const activeMode = REPORT_FIAT_MODE_OPTIONS.find((option) => option.value === mode);

  return (
    <div className={isPlain ? 'space-y-3' : 'space-y-3 rounded-lg border bg-muted/10 p-4'}>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          {!isPlain && <Coins className="h-3.5 w-3.5 text-muted-foreground" />}
          <Label htmlFor={`${idPrefix}-fiat-currency`}>Also show every figure in</Label>
          <InfoHint label="currency conversion">
            <p>
              Adds one more column next to each money column, holding the same figure in the
              currency you pick.
            </p>
            <p>
              The crypto columns never change. ADA stays ADA, and a stablecoin stays a stablecoin.
            </p>
            <p>
              A request is converted at one rate, so gross minus fees still equals net in the
              converted column too.
            </p>
          </InfoHint>
        </div>
        <Select
          value={currency}
          onValueChange={(value) =>
            onChange({
              fiatCurrency: isReportFiatCurrency(value) ? value : NO_FIAT_CURRENCY,
            })
          }
        >
          <SelectTrigger id={`${idPrefix}-fiat-currency`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_FIAT_CURRENCY}>No conversion, crypto amounts only</SelectItem>
            {currencies.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.symbol} {option.value.toUpperCase()} · {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isOn && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-fiat-mode`}>Which rate to use</Label>
          <Select
            value={mode}
            onValueChange={(value) => onChange({ fiatMode: value as ReportFiatMode })}
          >
            <SelectTrigger id={`${idPrefix}-fiat-mode`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORT_FIAT_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{activeMode?.hint}</p>
        </div>
      )}

      {isOn && issue && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{issue.message}</span>
        </p>
      )}

      {isOn && !issue && capability?.isConfigured && (
        <p className="text-[11px] text-muted-foreground">
          {capability.attribution}.
          {capability.isDemoKey
            ? ` This service uses a free CoinGecko key, so it can only price the last ${capability.historyDays ?? 365} days.`
            : ''}
        </p>
      )}
    </div>
  );
}
