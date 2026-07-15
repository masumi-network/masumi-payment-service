import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

// Radix Select cannot use an empty-string item value, so the "any" option uses
// this sentinel and is mapped back to null in the change handlers.
const ANY = '__any__';

const humanize = (value: string) => value.replace(/([A-Z])/g, ' $1').trim();

export const countActiveFilters = (filters: TransactionFilterState): number =>
  (filters.status ? 1 : 0) +
  (filters.type ? 1 : 0) +
  (filters.errorType ? 1 : 0) +
  (filters.needsAction ? 1 : 0);

type TransactionFiltersProps = {
  filters: TransactionFilterState;
  onChange: (filters: TransactionFilterState) => void;
};

export function TransactionFilters({ filters, onChange }: TransactionFiltersProps) {
  const activeCount = countActiveFilters(filters);

  return (
    <Popover>
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
      <PopoverContent align="end" className="w-72 space-y-4">
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

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Status</label>
          <Select
            value={filters.status ?? ANY}
            onValueChange={(value) =>
              onChange({ ...filters, status: value === ANY ? null : (value as OnChainStateFilter) })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Any status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any status</SelectItem>
              {ON_CHAIN_STATES.map((state) => (
                <SelectItem key={state} value={state}>
                  {humanize(state)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Type</label>
          <Select
            value={filters.type ?? ANY}
            onValueChange={(value) =>
              onChange({
                ...filters,
                type: value === ANY ? null : (value as 'payment' | 'purchase'),
              })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Any type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any type</SelectItem>
              <SelectItem value="payment">Payment</SelectItem>
              <SelectItem value="purchase">Purchase</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Error type</label>
          <Select
            value={filters.errorType ?? ANY}
            onValueChange={(value) =>
              onChange({
                ...filters,
                errorType: value === ANY ? null : (value as TransactionErrorType),
              })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Any error" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any error</SelectItem>
              {TRANSACTION_ERROR_TYPES.map((errorType) => (
                <SelectItem key={errorType} value={errorType}>
                  {humanize(errorType)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

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
