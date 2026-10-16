import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  REPORT_EXPORT_KINDS,
  isEveryReportCsvKind,
  type ReportCsvKind,
  type ReportExportKindOption,
} from './export-kinds';

type ExportKindPickerProps = Readonly<{
  selected: readonly ReportCsvKind[];
  onToggle: (kind: ReportCsvKind) => void;
  onToggleAll: (isSelected: boolean) => void;
}>;

function ExportKindRow({
  kind,
  isSelected,
  onToggle,
}: Readonly<{ kind: ReportExportKindOption; isSelected: boolean; onToggle: () => void }>) {
  // Folded away by default: the example answers "what will I get?", which is a
  // question an operator only asks once per file.
  const [isExampleOpen, setIsExampleOpen] = useState(false);
  const exampleId = `report-example-${kind.value}`;

  return (
    <div
      className={cn(
        'rounded-md border transition-colors',
        isSelected ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/40',
      )}
    >
      <label className="flex cursor-pointer items-start gap-2.5 p-3">
        <Checkbox className="mt-0.5" checked={isSelected} onCheckedChange={onToggle} />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{kind.label}</span>
          <span className="block text-xs text-muted-foreground">{kind.rowMeaning}</span>
        </span>
      </label>

      {isSelected && (
        <div className="border-t px-3 py-2.5">
          <p className="text-xs text-muted-foreground">{kind.useFor}</p>
          <button
            type="button"
            aria-expanded={isExampleOpen}
            aria-controls={exampleId}
            onClick={() => setIsExampleOpen((current) => !current)}
            className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', isExampleOpen && 'rotate-180')}
              aria-hidden="true"
            />
            {isExampleOpen ? 'Hide example row' : 'Show example row'}
          </button>

          {isExampleOpen && (
            <div id={exampleId} className="mt-2 rounded-md border bg-background/60 px-3 py-1.5">
              <dl>
                {kind.example.facts.map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-3 border-b py-1.5 text-xs"
                  >
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right">{value}</dd>
                  </div>
                ))}
              </dl>

              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    <th className="py-1.5 text-left font-normal">Amount</th>
                    {kind.example.assets.map((asset) => (
                      <th key={asset} className="py-1.5 pl-3 text-right font-normal">
                        {asset}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {kind.example.amounts.map((amount) => (
                    <tr key={amount.label} className="border-t">
                      <td className="py-1.5 text-muted-foreground">{amount.label}</td>
                      {amount.values.map((value, index) => (
                        <td
                          key={kind.example.assets[index]}
                          className="py-1.5 pl-3 text-right tabular-nums"
                        >
                          {value}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>

              <p className="border-t py-1.5 text-[11px] text-muted-foreground">
                Each asset is its own column in the file. Nothing is converted between them.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Picks which files to download and, on request, shows what one row of each
 * holds. The files differ only in how far the numbers are summed, which no
 * label can carry on its own.
 */
export function ExportKindPicker({ selected, onToggle, onToggleAll }: ExportKindPickerProps) {
  const hasEveryKind = isEveryReportCsvKind(selected);

  return (
    <div className="space-y-2">
      {REPORT_EXPORT_KINDS.map((kind) => (
        <ExportKindRow
          key={kind.value}
          kind={kind}
          isSelected={selected.includes(kind.value)}
          onToggle={() => onToggle(kind.value)}
        />
      ))}

      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-dashed p-3 hover:bg-muted/40">
        <Checkbox
          className="mt-0.5"
          checked={hasEveryKind}
          onCheckedChange={() => onToggleAll(!hasEveryKind)}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">All three files</span>
          <span className="block text-xs text-muted-foreground">
            Downloads one ZIP. Every file in it comes from the same snapshot.
          </span>
        </span>
      </label>

      <p className="text-[11px] text-muted-foreground">
        Every row repeats the payment source, period, filters, and the moment the figures were read,
        so a file explains itself without this dialog.
      </p>
    </div>
  );
}
