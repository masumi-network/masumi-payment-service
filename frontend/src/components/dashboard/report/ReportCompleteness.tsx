import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type ReportWarning = Readonly<{ code: string; message: string; rowId: string | null }>;

/**
 * The report marks a value "partial" whenever it could not read every input
 * behind it. Flagging that on each card, chart, and table cell drowned the
 * numbers, so the whole story now lives behind one quiet link, and an affected
 * value carries a small dot instead of a badge.
 */
export function ReportCompletenessNote({
  warnings,
  className,
}: Readonly<{ warnings: readonly ReportWarning[]; className?: string }>) {
  if (warnings.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'inline-flex items-center gap-1 text-xs text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground',
          className,
        )}
      >
        <Info className="h-3.5 w-3.5" />
        Some figures are estimates
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[90vw] p-4">
        <p className="text-sm font-medium">Why some figures are estimates</p>
        <p className="mt-1 text-xs text-muted-foreground">
          These numbers use every record the service could read. Anything below was missing or could
          not be traced to one wallet.
        </p>
        <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto text-xs text-muted-foreground">
          {warnings.map((warning, index) => (
            <li key={`${warning.code}:${warning.rowId ?? ''}:${index}`} className="flex gap-2">
              <span
                aria-hidden="true"
                className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current"
              />
              <span>{warning.message}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Marks a single value as an estimate. Muted on purpose: it should be findable
 * once the reader knows the report has estimates, not compete with the number.
 */
export function EstimateDot({ className }: Readonly<{ className?: string }>) {
  return (
    <span
      title="This figure is an estimate."
      aria-label="Estimate"
      className={cn(
        'inline-block h-1.5 w-1.5 shrink-0 translate-y-[-0.35em] rounded-full bg-muted-foreground/60',
        className,
      )}
    />
  );
}
