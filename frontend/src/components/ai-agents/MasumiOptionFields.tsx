import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Trash2, Plus } from 'lucide-react';
import { formatFundUnit } from '@/lib/utils';
import { REGISTRY_LIMITS } from '@/lib/registry-validation';
import type {
  MasumiOptionDraft,
  MasumiPriceUnit,
  MasumiStablecoinUnit,
} from '@/lib/agent-registration';

/**
 * Pricing editor for one V2 Masumi payment option (pricing model plus the
 * fixed coin/price rows). Pure view: state lives in the dialog and flows back
 * through `onChange`.
 */
export function MasumiOptionFields({
  option,
  optionNumber,
  network,
  stablecoinUnit,
  defaultPriceUnit,
  onChange,
}: {
  option: MasumiOptionDraft;
  optionNumber: number;
  network: 'Mainnet' | 'Preprod';
  stablecoinUnit: MasumiStablecoinUnit;
  defaultPriceUnit: MasumiPriceUnit;
  onChange: (option: MasumiOptionDraft) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium">
          Pricing model <span className="text-destructive">*</span>
        </label>
        <Select
          value={option.pricingType}
          onValueChange={(value: MasumiOptionDraft['pricingType']) =>
            onChange({
              ...option,
              pricingType: value,
              prices:
                value === 'Fixed'
                  ? option.prices.length > 0
                    ? option.prices
                    : [{ unit: defaultPriceUnit, amount: '' }]
                  : [],
            })
          }
        >
          <SelectTrigger aria-label={`Pricing model for payment option ${optionNumber}`}>
            <SelectValue placeholder="Select a pricing model" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="Fixed">Fixed price</SelectItem>
              <SelectItem value="Dynamic">Dynamic per payment</SelectItem>
              <SelectItem value="Free">Free</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {option.pricingType === 'Dynamic' ? (
          <p className="text-xs text-muted-foreground">
            Your agent sets the amount for each payment request.
          </p>
        ) : null}
        {option.pricingType === 'Free' ? (
          <p className="text-xs text-muted-foreground">
            Interactions do not require a Masumi escrow payment.
          </p>
        ) : null}
      </div>

      {option.pricingType === 'Fixed' ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-medium">
              Coins and prices <span className="text-destructive">*</span>
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={option.prices.length >= REGISTRY_LIMITS.pricingOptionCount}
              onClick={() =>
                onChange({
                  ...option,
                  prices: [...option.prices, { unit: defaultPriceUnit, amount: '' }],
                })
              }
            >
              <Plus data-icon="inline-start" />
              Add coin
            </Button>
          </div>
          {option.prices.map((price, priceIndex) => (
            <div
              key={`${option.id}-${priceIndex}`}
              className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start"
            >
              <div className="min-w-0 flex-1">
                <Select
                  value={price.unit}
                  onValueChange={(unit: MasumiOptionDraft['prices'][number]['unit']) =>
                    onChange({
                      ...option,
                      prices: option.prices.map((candidate, index) =>
                        index === priceIndex ? { ...candidate, unit } : candidate,
                      ),
                    })
                  }
                >
                  <SelectTrigger aria-label={`Coin for Masumi price ${priceIndex + 1}`}>
                    <SelectValue placeholder="Select a coin" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={stablecoinUnit}>{stablecoinUnit}</SelectItem>
                      <SelectItem value="lovelace">
                        {formatFundUnit('lovelace', network)}
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 flex-1">
                <Input
                  type="number"
                  inputMode="decimal"
                  aria-label={`Amount for Masumi price ${priceIndex + 1}`}
                  placeholder="0.00"
                  onWheel={(event) => event.currentTarget.blur()}
                  value={price.amount}
                  onChange={(event) =>
                    onChange({
                      ...option,
                      prices: option.prices.map((candidate, index) =>
                        index === priceIndex
                          ? { ...candidate, amount: event.target.value }
                          : candidate,
                      ),
                    })
                  }
                  min="0"
                  step="0.000001"
                />
              </div>
              {option.prices.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 self-end sm:h-9 sm:w-9 sm:self-auto"
                  aria-label={`Remove Masumi price ${priceIndex + 1}`}
                  onClick={() =>
                    onChange({
                      ...option,
                      prices: option.prices.filter((_, index) => index !== priceIndex),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
