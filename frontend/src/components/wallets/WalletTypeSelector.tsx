import { Check, Landmark, ShoppingCart, Store } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getWalletTypeLabel, type HotWalletType } from '@/lib/wallet-type';

const WALLET_TYPE_OPTIONS: Array<{
  type: HotWalletType;
  description: string;
  icon: typeof ShoppingCart;
}> = [
  {
    type: 'Purchasing',
    description: 'Pays for agent services',
    icon: ShoppingCart,
  },
  {
    type: 'Selling',
    description: 'Receives service revenue',
    icon: Store,
  },
  {
    type: 'Funding',
    description: 'Supplies automatic top-ups',
    icon: Landmark,
  },
];

export function WalletTypeSelector({
  value,
  onChange,
  disabled = false,
}: {
  value: HotWalletType;
  onChange: (type: HotWalletType) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Wallet type</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {WALLET_TYPE_OPTIONS.map((option) => {
          const Icon = option.icon;
          const isSelected = value === option.type;

          return (
            <label
              key={option.type}
              className={cn(
                'relative cursor-pointer rounded-lg border bg-background transition-colors',
                'hover:border-foreground/30 hover:bg-muted/30',
                isSelected && 'border-foreground bg-muted/50',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                type="radio"
                name="wallet-type"
                value={option.type}
                checked={isSelected}
                onChange={() => onChange(option.type)}
                disabled={disabled}
                className="peer sr-only"
              />
              <span className="flex min-h-24 flex-col gap-2 rounded-lg p-3 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2">
                <span className="flex items-center justify-between">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                    <Icon className="h-4 w-4" />
                  </span>
                  {isSelected && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </span>
                <span>
                  <span className="block text-sm font-medium">
                    {getWalletTypeLabel(option.type)}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
