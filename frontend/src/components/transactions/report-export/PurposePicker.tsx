import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { REPORT_PURPOSE_CARDS, type ReportPurpose } from './report-purposes';

type PurposePickerProps = Readonly<{
  value: ReportPurpose;
  onChange: (value: ReportPurpose) => void;
}>;

/**
 * The first choice in the dialog. It decides which filters and rules appear
 * below, so an operator answers one question instead of reading eleven fields.
 */
export function PurposePicker({ value, onChange }: PurposePickerProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="What do you need">
      {REPORT_PURPOSE_CARDS.map((purpose) => {
        const isSelected = purpose.value === value;
        return (
          <button
            key={purpose.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange(purpose.value)}
            className={cn(
              'flex items-start justify-between gap-2 rounded-md border p-3 text-left transition-colors',
              isSelected ? 'border-primary/40 bg-primary/10' : 'hover:bg-muted/40',
            )}
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{purpose.label}</span>
              <span className="block text-xs leading-tight text-muted-foreground">
                {purpose.detail}
              </span>
            </span>
            {isSelected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
          </button>
        );
      })}
    </div>
  );
}
