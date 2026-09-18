import { cn } from '@/lib/utils';
import { TOOLTIP_TEXTS } from '@/lib/constants/tooltips';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getWalletTypeLabel, type HotWalletType } from '@/lib/wallet-type';
import { Landmark, ShoppingCart, Store } from 'lucide-react';

interface WalletTypeBadgeProps {
  type: HotWalletType;
  className?: string;
  showTooltip?: boolean;
  /** Icon-only square for dense lists (no pill hover). */
  variant?: 'default' | 'icon';
}

function getTooltipText(type: HotWalletType): string {
  switch (type) {
    case 'Purchasing':
      return TOOLTIP_TEXTS.BUYING_WALLET_TYPE;
    case 'Funding':
      return TOOLTIP_TEXTS.FUNDING_WALLET_TYPE;
    case 'Selling':
      return TOOLTIP_TEXTS.SELLING_WALLET_TYPE;
  }
}

export function WalletTypeIcon({ type, className }: { type: HotWalletType; className?: string }) {
  switch (type) {
    case 'Purchasing':
      return <ShoppingCart className={cn('h-3 w-3', className)} aria-hidden />;
    case 'Funding':
      return <Landmark className={cn('h-3 w-3', className)} aria-hidden />;
    case 'Selling':
      return <Store className={cn('h-3 w-3', className)} aria-hidden />;
  }
}

export function WalletTypeBadge({
  type,
  className,
  showTooltip = true,
  variant = 'default',
}: WalletTypeBadgeProps) {
  const displayName = getWalletTypeLabel(type);

  if (variant === 'icon') {
    const iconBadge = (
      <span
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/30 text-muted-foreground',
          className,
        )}
        aria-label={displayName}
      >
        <WalletTypeIcon type={type} />
      </span>
    );
    if (!showTooltip) return iconBadge;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{iconBadge}</TooltipTrigger>
        <TooltipContent className="max-w-sm p-3">
          <p className="text-sm whitespace-pre-line">{getTooltipText(type)}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  const badge = (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground',
        showTooltip &&
          'cursor-help transition-colors hover:border-foreground/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className,
      )}
      tabIndex={showTooltip ? 0 : undefined}
    >
      <WalletTypeIcon type={type} />
      {displayName}
    </span>
  );

  if (!showTooltip) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-sm p-3">
        <p className="text-sm whitespace-pre-line">{getTooltipText(type)}</p>
      </TooltipContent>
    </Tooltip>
  );
}
