import { AlertTriangle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  REPORT_FIAT_MODE_OPTIONS,
  type FiatIssue,
  type ReportFiatCapability,
  type ReportFiatMode,
} from '@/lib/transaction-report/fiat-settings';

type FiatRateStripProps = Readonly<{
  mode: ReportFiatMode;
  capability: ReportFiatCapability | null;
  issue: FiatIssue | null;
  onChange: (patch: Readonly<{ fiatMode: ReportFiatMode }>) => void;
}>;

/**
 * The settings behind a converted figure, shown only while one is on screen.
 *
 * The currency itself is picked in the asset dropdown, because a converted
 * total is one more way to read the same report. What is left is how the rate
 * was chosen and who supplied it, which belongs next to the figures it explains
 * rather than in a panel of its own.
 */
export function FiatRateStrip({ mode, capability, issue, onChange }: FiatRateStripProps) {
  const activeMode = REPORT_FIAT_MODE_OPTIONS.find((option) => option.value === mode);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-muted/10 px-3 py-2">
      <Label htmlFor="report-fiat-mode" className="text-xs font-normal text-muted-foreground">
        Converted at
      </Label>
      <Select
        value={mode}
        onValueChange={(value) => onChange({ fiatMode: value as ReportFiatMode })}
      >
        <SelectTrigger id="report-fiat-mode" className="h-8 w-auto min-w-56 text-xs">
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

      {issue ? (
        <p className="flex w-full items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{issue.message}</span>
        </p>
      ) : (
        capability?.isConfigured && (
          <p className="w-full text-[11px] text-muted-foreground">
            {capability.attribution}.
            {capability.isDemoKey
              ? ` This service uses a free CoinGecko key, so it can only price the last ${capability.historyDays ?? 365} days.`
              : ''}
          </p>
        )
      )}
    </div>
  );
}
