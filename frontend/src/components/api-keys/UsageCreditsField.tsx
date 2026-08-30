'use client';

import { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { convertBaseUnitsToDecimal } from '@/lib/convertDecimalToBaseUnits';
import { shortenCreditUnit, type CreditUnitOption } from '@/lib/api-key-credit-units';

/** One editable balance. `amount` is a human decimal string, not base units. */
export interface CreditRow {
  unit: string;
  amount: string;
  /** Carried on the row so the form can validate precision without the option list. */
  decimals: number;
}

interface UsageCreditsFieldProps {
  /** Units this key can actually spend, derived from its own access list. */
  options: CreditUnitOption[];
  rows: CreditRow[];
  /** The key's stored balances in base units, used for the "currently" hint. */
  current: Array<{ unit: string; amount: string }>;
  onChange: (rows: CreditRow[]) => void;
  disabled?: boolean;
  /** Message per row index, keyed the same way the form validates. */
  rowErrors?: Record<number, string | undefined>;
}

function optionFor(options: CreditUnitOption[], unit: string): CreditUnitOption | undefined {
  return options.find((option) => option.unit === unit);
}

function currentBalanceLabel(
  current: Array<{ unit: string; amount: string }>,
  unit: string,
  decimals: number,
): string {
  const stored = current.find((row) => row.unit === unit);
  if (!stored) return 'not funded yet';
  try {
    return `currently ${convertBaseUnitsToDecimal(stored.amount, decimals)}`;
  } catch {
    // A row the ledger holds in a shape this form cannot parse still has to be
    // visible; showing the raw value beats hiding the balance entirely.
    return `currently ${stored.amount} base units`;
  }
}

export function UsageCreditsField({
  options,
  rows,
  current,
  onChange,
  disabled = false,
  rowErrors,
}: UsageCreditsFieldProps) {
  const groupedAvailable = useMemo(() => {
    const taken = new Set(rows.map((row) => row.unit));
    const groups = new Map<string, Array<{ option: CreditUnitOption; index: number }>>();
    options.forEach((option, index) => {
      if (taken.has(option.unit)) return;
      const bucket = groups.get(option.group) ?? [];
      bucket.push({ option, index });
      groups.set(option.group, bucket);
    });
    return Array.from(groups.entries());
  }, [options, rows]);

  const hasAvailable = groupedAvailable.some(([, entries]) => entries.length > 0);

  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No credit units on this key. A usage-limited key with no credits cannot pay for anything:
          every purchase is rejected with &quot;Insufficient funds&quot;.
        </p>
      )}

      {rows.map((row, index) => {
        const option = optionFor(options, row.unit);
        return (
          <div key={row.unit} className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor={`credit-${index}`} className="text-xs text-muted-foreground">
                {option?.label ?? shortenCreditUnit(row.unit)}
                <span className="ml-1 opacity-70">
                  {option ? option.group : 'unknown unit'} ·{' '}
                  {currentBalanceLabel(current, row.unit, row.decimals)}
                </span>
              </Label>
              <Input
                id={`credit-${index}`}
                type="text"
                inputMode="decimal"
                disabled={disabled}
                value={row.amount}
                placeholder="0.00"
                onChange={(event) => {
                  const next = [...rows];
                  next[index] = { ...row, amount: event.target.value };
                  onChange(next);
                }}
              />
              <p className="font-mono text-[0.6875rem] break-all text-muted-foreground">
                {option?.identifier ?? row.unit}
              </p>
              {rowErrors?.[index] && <p className="text-xs text-destructive">{rowErrors[index]}</p>}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Set this balance to zero"
              aria-label={`Zero the ${option?.label ?? shortenCreditUnit(row.unit)} balance`}
              disabled={disabled}
              onClick={() => onChange(rows.filter((_, position) => position !== index))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      })}

      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This key has no Cardano network and no EVM chain in its access list, so there is nothing
          to fund yet.
        </p>
      ) : (
        hasAvailable && (
          <Select
            // Radix rejects an empty option value and ADA's unit IS the empty string, so
            // the picker addresses options by index and maps back here.
            value=""
            disabled={disabled}
            onValueChange={(value) => {
              const option = options[Number(value)];
              if (!option) return;
              onChange([...rows, { unit: option.unit, amount: '', decimals: option.decimals }]);
            }}
          >
            <SelectTrigger aria-label="Add a credit unit">
              <SelectValue placeholder="Add a credit unit" />
            </SelectTrigger>
            <SelectContent>
              {groupedAvailable.map(([group, entries]) => (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {entries.map(({ option, index }) => (
                    <SelectItem key={option.unit || 'ada'} value={String(index)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        )
      )}
    </div>
  );
}
