'use client';

import { useMemo, useState } from 'react';
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
import {
  buildCustomCreditUnit,
  DEFAULT_CREDIT_DECIMALS,
  shortenCreditUnit,
  type CreditChain,
  type CreditUnitOption,
} from '@/lib/api-key-credit-units';

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

/** Fallback name for a custom asset whose symbol the operator left blank. */
const UNNAMED_CUSTOM_SYMBOL = 'Custom';

function currentBalanceLabel(
  current: Array<{ unit: string; amount: string }>,
  unit: string,
  decimals: number,
  symbol: string,
): string {
  const stored = current.find((row) => row.unit === unit);
  if (!stored) return 'not funded yet';
  try {
    return `currently ${convertBaseUnitsToDecimal(stored.amount, decimals)} ${symbol}`;
  } catch {
    // A row the ledger holds in a shape this form cannot parse still has to be
    // visible; showing the raw value beats hiding the balance entirely.
    return `currently ${stored.amount} base units`;
  }
}

/** The chain a group's units settle on, read off any option already in that group. */
function chainForGroup(options: CreditUnitOption[], group: string): CreditChain {
  return options.find((option) => option.group === group)?.chain ?? { kind: 'unknown' };
}

interface CustomEntry {
  group: string;
  chain: CreditChain;
  value: string;
  symbol: string;
  decimals: string;
  error?: string;
}

/** Distinguishes the "add a custom asset" rows from the numeric option indices. */
const CUSTOM_OPTION_PREFIX = 'custom:';

export function UsageCreditsField({
  options,
  rows,
  current,
  onChange,
  disabled = false,
  rowErrors,
}: UsageCreditsFieldProps) {
  const [customEntry, setCustomEntry] = useState<CustomEntry | null>(null);
  // Options for units added in this session. They are not in `options` (which is
  // derived from the key's presets), so without them a just-added custom row falls
  // back to 'unknown unit' and puts its own elided id where the symbol belongs.
  const [customOptions, setCustomOptions] = useState<CreditUnitOption[]>([]);
  const knownOptions = useMemo(() => [...options, ...customOptions], [options, customOptions]);

  const groupedAvailable = useMemo(() => {
    const taken = new Set(rows.map((row) => row.unit));
    const groups = new Map<string, Array<{ option: CreditUnitOption; index: number }>>();
    options.forEach((option, index) => {
      if (taken.has(option.unit)) return;
      const bucket = groups.get(option.group) ?? [];
      bucket.push({ option, index });
      groups.set(option.group, bucket);
    });
    // A group whose presets are all taken still needs a row, because the custom
    // entry below lives inside it.
    for (const option of options) {
      if (!groups.has(option.group)) groups.set(option.group, []);
    }
    return Array.from(groups.entries());
  }, [options, rows]);

  const takenUnits = useMemo(() => new Set(rows.map((row) => row.unit)), [rows]);

  function addCustomUnit(entry: CustomEntry) {
    const built = buildCustomCreditUnit(entry.chain, entry.value);
    if ('error' in built) {
      setCustomEntry({ ...entry, error: built.error });
      return;
    }
    if (takenUnits.has(built.unit)) {
      setCustomEntry({ ...entry, error: 'That asset is already in the list' });
      return;
    }
    const decimals = Number(entry.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
      setCustomEntry({ ...entry, error: 'Decimals must be a whole number from 0 to 30' });
      return;
    }
    setCustomOptions((previous) => [
      ...previous,
      {
        unit: built.unit,
        label: entry.symbol.trim() || UNNAMED_CUSTOM_SYMBOL,
        group: entry.group,
        identifier: built.unit,
        decimals,
        chain: entry.chain,
      },
    ]);
    onChange([...rows, { unit: built.unit, amount: '', decimals }]);
    setCustomEntry(null);
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No credit units on this key. A usage-limited key with no credits cannot pay for anything:
          every purchase is rejected with &quot;Insufficient funds&quot;.
        </p>
      )}

      {rows.map((row, index) => {
        const option = optionFor(knownOptions, row.unit);
        const symbol = option?.label ?? shortenCreditUnit(row.unit);
        return (
          <div key={row.unit} className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor={`credit-${index}`} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{symbol}</span>
                <span className="ml-1 opacity-70">
                  {option ? option.group : 'unknown unit'} ·{' '}
                  {currentBalanceLabel(current, row.unit, row.decimals, symbol)}
                </span>
              </Label>
              {/* The symbol sits against the amount because the identifier line below
                  used to be the only unit next to the number: an ADA row read as
                  "250" over "lovelace", which is 250 ADA and 250_000_000 lovelace. */}
              <div className="flex items-center gap-2">
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
                <span className="shrink-0 text-sm font-medium">{symbol}</span>
              </div>
              <p className="text-[0.6875rem] break-all text-muted-foreground">
                <span className="mr-1 uppercase opacity-70">unit id</span>
                <span className="font-mono">{option?.identifier ?? row.unit}</span>
              </p>
              {rowErrors?.[index] && <p className="text-xs text-destructive">{rowErrors[index]}</p>}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Set this balance to zero"
              aria-label={`Zero the ${symbol} balance`}
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
        <Select
          // Radix rejects an empty option value and ADA's unit IS the empty string, so
          // the picker addresses options by index and maps back here.
          value=""
          disabled={disabled}
          onValueChange={(value) => {
            if (value.startsWith(CUSTOM_OPTION_PREFIX)) {
              const group = value.slice(CUSTOM_OPTION_PREFIX.length);
              setCustomEntry({
                group,
                chain: chainForGroup(options, group),
                value: '',
                symbol: '',
                decimals: String(DEFAULT_CREDIT_DECIMALS),
              });
              return;
            }
            const option = options[Number(value)];
            if (!option) return;
            onChange([...rows, { unit: option.unit, amount: '', decimals: option.decimals }]);
          }}
        >
          <SelectTrigger aria-label="Add a credit unit">
            <SelectValue placeholder="Add a credit unit" />
          </SelectTrigger>
          <SelectContent>
            {groupedAvailable.map(([group, entries]) => {
              const chain = chainForGroup(options, group);
              // 'Already on this key' collects units whose chain cannot be recovered
              // from the stored string, so it can list what is there but cannot
              // validate anything new typed into it.
              const acceptsCustom = chain.kind !== 'unknown';
              if (entries.length === 0 && !acceptsCustom) return null;
              return (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {entries.map(({ option, index }) => (
                    <SelectItem key={option.unit || 'ada'} value={String(index)}>
                      {option.label}
                    </SelectItem>
                  ))}
                  {acceptsCustom && (
                    <SelectItem value={`${CUSTOM_OPTION_PREFIX}${group}`}>
                      Custom asset&hellip;
                    </SelectItem>
                  )}
                </SelectGroup>
              );
            })}
          </SelectContent>
        </Select>
      )}

      {customEntry && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">Custom asset on {customEntry.group}</p>
          <div className="space-y-1.5">
            <Label htmlFor="custom-credit-unit" className="text-xs text-muted-foreground">
              {customEntry.chain.kind === 'evm'
                ? 'Token contract address'
                : 'Policy id + asset name, as hex'}
            </Label>
            <Input
              id="custom-credit-unit"
              value={customEntry.value}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder={
                customEntry.chain.kind === 'evm' ? '0x…' : '56 hex characters, then the asset name'
              }
              onChange={(event) =>
                setCustomEntry({ ...customEntry, value: event.target.value, error: undefined })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custom-credit-symbol" className="text-xs text-muted-foreground">
              Symbol
            </Label>
            <Input
              id="custom-credit-symbol"
              value={customEntry.symbol}
              autoComplete="off"
              placeholder={UNNAMED_CUSTOM_SYMBOL}
              onChange={(event) => setCustomEntry({ ...customEntry, symbol: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Shown next to the amount, so the balance reads as an asset and not as a raw id.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custom-credit-decimals" className="text-xs text-muted-foreground">
              Decimals
            </Label>
            <Input
              id="custom-credit-decimals"
              type="text"
              inputMode="numeric"
              value={customEntry.decimals}
              onChange={(event) =>
                setCustomEntry({ ...customEntry, decimals: event.target.value, error: undefined })
              }
            />
            {/* Decimals only scale what this form shows and sends; getting them wrong
                funds the key by a factor of ten, so they are asked for rather than
                assumed for an asset the presets do not describe. */}
            <p className="text-xs text-muted-foreground">
              How many decimal places the asset uses. Most stablecoins use 6.
            </p>
          </div>
          {customEntry.error && <p className="text-xs text-destructive">{customEntry.error}</p>}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => addCustomUnit(customEntry)}
            >
              Add asset
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCustomEntry(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
