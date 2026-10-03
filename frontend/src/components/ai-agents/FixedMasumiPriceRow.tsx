import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getPriceAmountLabel } from '@/lib/agent-registration-price-label';
import { cn } from '@/lib/utils';

interface FixedMasumiPriceRowProps {
  displayUnit: string;
  priceIndex: number;
  coinSelect: ReactNode;
  amountInput: ReactNode;
  amountError?: ReactNode;
  onRemove?: () => void;
}

/** Coin + amount row: labels on one grid row, controls on the next (aligned on sm+). */
export function FixedMasumiPriceRow({
  displayUnit,
  priceIndex: _priceIndex,
  coinSelect,
  amountInput,
  amountError,
  onRemove,
}: FixedMasumiPriceRowProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-y-1 sm:grid-rows-[auto_auto] sm:gap-x-2 sm:gap-y-1',
        onRemove ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem]' : 'sm:grid-cols-2',
      )}
    >
      <label className="col-start-1 row-start-1 text-xs font-medium leading-none">Coin</label>
      <label className="col-start-1 row-start-3 text-xs font-medium leading-none sm:col-start-2 sm:row-start-1">
        {getPriceAmountLabel(displayUnit)}
      </label>
      <div className="col-start-1 row-start-2 sm:row-start-2">{coinSelect}</div>
      <div className="col-start-1 row-start-4 sm:col-start-2 sm:row-start-2">
        {amountInput}
        {amountError}
      </div>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="col-start-1 row-start-5 h-10 w-10 justify-self-end sm:col-start-3 sm:row-start-2 sm:justify-self-center sm:self-center"
          aria-label={`Remove Masumi price ${_priceIndex + 1}`}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      ) : null}
    </div>
  );
}
