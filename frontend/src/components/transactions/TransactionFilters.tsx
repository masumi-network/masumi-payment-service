import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { ON_CHAIN_STATES, type OnChainStateFilter } from '@/lib/hooks/useTransactions';

export type TransactionFilterState = {
  /** On-chain state — applied server-side via filterOnChainState. */
  status: OnChainStateFilter | null;
  /** Transaction type — applied server-side via transactionType. */
  type: 'payment' | 'purchase' | null;
  /** Recorded NextAction error type — applied client-side (no server param). */
  errorType: TransactionErrorType | null;
  /** Only rows needing manual resolution — server-side via filterNeedsManualAction. */
  needsAction: boolean;
};

// Union of payment + purchase NextAction.errorType values from the generated API types.
export const TRANSACTION_ERROR_TYPES = ['NetworkError', 'InsufficientFunds', 'Unknown'] as const;
export type TransactionErrorType = (typeof TRANSACTION_ERROR_TYPES)[number];

export const EMPTY_FILTERS: TransactionFilterState = {
  status: null,
  type: null,
  errorType: null,
  needsAction: false,
};

// Radix menus cannot use an empty-string item value, so the "any" option uses
// this sentinel and is mapped back to null in the change handlers.
const ANY = '__any__';

const humanize = (value: string) => value.replace(/([A-Z])/g, ' $1').trim();

export const countActiveFilters = (filters: TransactionFilterState): number =>
  (filters.status ? 1 : 0) +
  (filters.type ? 1 : 0) +
  (filters.errorType ? 1 : 0) +
  (filters.needsAction ? 1 : 0);

type FilterMenuOption = { value: string; label: string };

type FilterMenuProps = {
  id: string;
  label: string;
  value: string | null;
  anyLabel: string;
  options: readonly FilterMenuOption[];
  onChange: (value: string | null) => void;
};

/** Single-value filter control styled like Select, implemented as DropdownMenu so it layers correctly inside the filters popover. */
function FilterMenu({ id, label, value, anyLabel, options, onChange }: FilterMenuProps) {
  const selectedLabel =
    value === null ? anyLabel : (options.find((option) => option.value === value)?.label ?? value);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            className={cn(
              'h-9 w-full justify-between px-3 font-normal shadow-none',
              value === null && 'text-muted-foreground',
            )}
          >
            <span className="truncate">{selectedLabel}</span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="z-[10001] max-h-[min(var(--radix-dropdown-menu-content-available-height,300px),300px)] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
        >
          <DropdownMenuRadioGroup
            value={value ?? ANY}
            onValueChange={(next) => onChange(next === ANY ? null : next)}
          >
            <DropdownMenuRadioItem value={ANY}>{anyLabel}</DropdownMenuRadioItem>
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

type TransactionFiltersProps = {
  filters: TransactionFilterState;
  onChange: (filters: TransactionFilterState) => void;
};

const STATUS_OPTIONS: FilterMenuOption[] = ON_CHAIN_STATES.map((state) => ({
  value: state,
  label: humanize(state),
}));

const TYPE_OPTIONS: FilterMenuOption[] = [
  { value: 'payment', label: 'Payment' },
  { value: 'purchase', label: 'Purchase' },
];

const ERROR_TYPE_OPTIONS: FilterMenuOption[] = TRANSACTION_ERROR_TYPES.map((errorType) => ({
  value: errorType,
  label: humanize(errorType),
}));

export function TransactionFilters({ filters, onChange }: TransactionFiltersProps) {
  const activeCount = countActiveFilters(filters);

  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="flex items-center gap-2 btn-hover-lift">
          <SlidersHorizontal className="h-4 w-4" />
          Filters
          {activeCount > 0 && (
            <Badge variant="secondary" className="ml-1 h-5 px-1.5">
              {activeCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-4 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Filters</span>
          {activeCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => onChange(EMPTY_FILTERS)}
            >
              <X className="mr-1 h-3 w-3" />
              Clear all
            </Button>
          )}
        </div>

        <FilterMenu
          id="tx-filter-status"
          label="Status"
          anyLabel="Any status"
          value={filters.status}
          options={STATUS_OPTIONS}
          onChange={(status) =>
            onChange({
              ...filters,
              status: status as OnChainStateFilter | null,
            })
          }
        />

        <FilterMenu
          id="tx-filter-type"
          label="Type"
          anyLabel="Any type"
          value={filters.type}
          options={TYPE_OPTIONS}
          onChange={(type) =>
            onChange({
              ...filters,
              type: type as 'payment' | 'purchase' | null,
            })
          }
        />

        <FilterMenu
          id="tx-filter-error-type"
          label="Error type"
          anyLabel="Any error"
          value={filters.errorType}
          options={ERROR_TYPE_OPTIONS}
          onChange={(errorType) =>
            onChange({
              ...filters,
              errorType: errorType as TransactionErrorType | null,
            })
          }
        />

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={filters.needsAction}
            onCheckedChange={(checked) => onChange({ ...filters, needsAction: checked === true })}
          />
          Needs manual action / has error
        </label>
      </PopoverContent>
    </Popover>
  );
}
