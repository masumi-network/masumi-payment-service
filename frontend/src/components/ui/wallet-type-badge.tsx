import { cn } from '@/lib/utils';
import { TOOLTIP_TEXTS } from '@/lib/constants/tooltips';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getWalletTypeLabel, type HotWalletType } from '@/lib/wallet-type';

interface WalletTypeBadgeProps {
  type: HotWalletType;
  className?: string;
  showTooltip?: boolean;
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

function getBadgeClassName(type: HotWalletType): string {
  switch (type) {
    case 'Purchasing':
      return 'bg-primary text-primary-foreground';
    case 'Funding':
      return 'bg-emerald-50 dark:bg-[#0f02] text-emerald-600 dark:text-emerald-400';
    case 'Selling':
      return 'bg-orange-50 dark:bg-[#f002] text-orange-600 dark:text-orange-400';
  }
}

export function WalletTypeBadge({ type, className, showTooltip = true }: WalletTypeBadgeProps) {
  const displayName = getWalletTypeLabel(type);

  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
          getBadgeClassName(type),
        )}
      >
        {displayName}
      </span>
      {showTooltip && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-muted-foreground/50 hover:border-muted-foreground text-xs text-muted-foreground hover:text-foreground cursor-help transition-colors"
              aria-label={`Information about ${displayName} wallet`}
            >
              ?
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm p-3">
            <p className="text-sm whitespace-pre-line">{getTooltipText(type)}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
