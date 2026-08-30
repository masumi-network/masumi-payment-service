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
  /**
   * Names for units added in this session, held by the parent because this field is
   * unmounted whenever the cap is switched off and would otherwise forget them.
   */
  customOptions: CreditUnitOption[];
  onCustomOptionsChange: (options: CreditUnitOption[]) => void;
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
    return `currently ${convertBaseUnitsToDecimal(stored.amount, decimals)} ${symbol}`.trim();
  } catch {
    // A row the ledger holds in a shape this form cannot parse still has to be
    // visible; showing the raw value beats hiding the balance entirely.
    return `currently ${stored.amount} base units`;
  }
}

/** The chain a group's units settle on, read off any option already in that group. */
function chainForGroup(options: CreditUnitOption[], groupId: string): CreditChain {
  return options.find((option) => option.groupId === groupId)?.chain ?? { kind: 'unknown' };
}

/** The group's display name, which unlike its id is not guaranteed unique. */
function nameForGroup(options: CreditUnitOption[], groupId: string): string {
  return options.find((option) => option.groupId === groupId)?.group ?? groupId;
}

interface CustomEntry {
  groupId: string;
  groupName: string;
  chain: CreditChain;
  value: string;
  symbol: string;
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
  customOptions,
  onCustomOptionsChange,
}: UsageCreditsFieldProps) {
  const [customEntry, setCustomEntry] = useState<CustomEntry | null>(null);
  // Custom names first. Without them a just-added row falls back to 'unknown unit' and
  // puts its own elided id where the symbol belongs; and a unit already on the ledger
  // appears in `options` under that same elided id, so with lookups taking the first
  // match the operator's own name has to come first to win.
  const knownOptions = useMemo(() => [...customOptions, ...options], [customOptions, options]);

  const groupedAvailable = useMemo(() => {
    const taken = new Set(rows.map((row) => row.unit));
    const groups = new Map<string, Array<{ option: CreditUnitOption; index: number }>>();
    options.forEach((option, index) => {
      if (taken.has(option.unit)) return;
      const bucket = groups.get(option.groupId) ?? [];
      bucket.push({ option, index });
      groups.set(option.groupId, bucket);
    });
    // A group whose presets are all taken still needs a row, because the custom
    // entry below lives inside it.
    for (const option of options) {
      if (!groups.has(option.groupId)) groups.set(option.groupId, []);
    }
    return Array.from(groups.entries());
  }, [options, rows]);

  const takenUnits = useMemo(() => new Set(rows.map((row) => row.unit)), [rows]);

  // A key whose access list is empty still gets options for the units already on its
  // ledger, and those cannot take a custom asset. Once they are all placed as rows the
  // picker has nothing left to offer, so it is hidden rather than opened onto nothing.
  const hasSomethingToAdd = groupedAvailable.some(
    ([groupId, entries]) =>
      entries.length > 0 || chainForGroup(options, groupId).kind !== 'unknown',
  );

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
    // Typing an address the picker already lists is not an error, but the preset knows
    // the asset better than the entry form does: it carries the real symbol and, more
    // importantly, the real decimals. Taking those keeps the row out of base units and
    // stops a stale custom name shadowing the preset after the row is removed and
    // re-added from the picker.
    // Chain 'unknown' means the option was recovered from the ledger, not configured on
    // the node: its label is the elided unit id and its decimals are a fallback, so it
    // knows nothing the entry form does not and must not override the typed symbol.
    const preset = options.find(
      (option) => option.unit === built.unit && option.chain.kind !== 'unknown',
    );
    const named = customOptions.filter((option) => option.unit !== built.unit);
    onCustomOptionsChange(
      preset !== undefined
        ? named
        : [
            ...named,
            {
              unit: built.unit,
              label: entry.symbol.trim() || UNNAMED_CUSTOM_SYMBOL,
              groupId: entry.groupId,
              group: entry.groupName,
              identifier: built.unit,
              // Base units, like every other unit nothing describes. PATCH carries only
              // unit and amount, so decimals typed here would be gone on the next open
              // and the same balance would read back rescaled.
              decimals: 0,
              chain: entry.chain,
            },
          ],
    );
    onChange([...rows, { unit: built.unit, amount: '', decimals: preset?.decimals ?? 0 }]);
    setCustomEntry(null);
  }

  return (
    <div className="space-y-3">
      {rows.map((row, index) => {
        const option = optionFor(knownOptions, row.unit);
        const heading = option?.label ?? shortenCreditUnit(row.unit);
        // What the number beside the input is counted in. A 0dp row holds base units
        // whatever the asset is called, so naming it after the asset would put "250"
        // next to a symbol that means a million times more, which is the misread this
        // field exists to prevent. A unit nothing describes has no symbol at all, only
        // its own id, which the unit-id line below already shows.
        const denomination = row.decimals === 0 ? 'base units' : heading;
        return (
          <div key={row.unit} className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor={`credit-${index}`} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{heading}</span>
                <span className="ml-1 opacity-70">
                  {option ? option.group : 'unknown unit'} ·{' '}
                  {currentBalanceLabel(current, row.unit, row.decimals, denomination)}
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
                <span className="shrink-0 text-sm font-medium text-muted-foreground">
                  {denomination}
                </span>
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
              aria-label={`Zero the ${heading} balance`}
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
        hasSomethingToAdd && (
          <Select
            // Radix rejects an empty option value and ADA's unit IS the empty string, so
            // the picker addresses options by index and maps back here.
            value=""
            disabled={disabled}
            onValueChange={(value) => {
              if (value.startsWith(CUSTOM_OPTION_PREFIX)) {
                const groupId = value.slice(CUSTOM_OPTION_PREFIX.length);
                setCustomEntry({
                  groupId,
                  groupName: nameForGroup(options, groupId),
                  chain: chainForGroup(options, groupId),
                  value: '',
                  symbol: '',
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
              {groupedAvailable.map(([groupId, entries]) => {
                const chain = chainForGroup(options, groupId);
                // 'Already on this key' collects units whose chain cannot be recovered
                // from the stored string, so it can list what is there but cannot
                // validate anything new typed into it.
                const acceptsCustom = chain.kind !== 'unknown';
                if (entries.length === 0 && !acceptsCustom) return null;
                return (
                  <SelectGroup key={groupId}>
                    <SelectLabel>{nameForGroup(options, groupId)}</SelectLabel>
                    {entries.map(({ option, index }) => (
                      <SelectItem key={option.unit || 'ada'} value={String(index)}>
                        {option.label}
                      </SelectItem>
                    ))}
                    {acceptsCustom && (
                      <SelectItem value={`${CUSTOM_OPTION_PREFIX}${groupId}`}>
                        Custom asset&hellip;
                      </SelectItem>
                    )}
                  </SelectGroup>
                );
              })}
            </SelectContent>
          </Select>
        )
      )}

      {customEntry && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">Custom asset on {customEntry.groupName}</p>
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
              Names the row, so it does not read as a bare id. Optional.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Its balance is entered in base units, because nothing here records how many decimals the
            asset uses and the node stores only the unit and the amount.
          </p>
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
