import { cn } from '@/lib/utils';
import { TOOLTIP_TEXTS } from '@/lib/constants/tooltips';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface WalletTypeBadgeProps {
  type: 'Purchasing' | 'Selling';
  className?: string;
  showTooltip?: boolean;
}

export function WalletTypeBadge({
  type,
  className,
  showTooltip = true,
}: WalletTypeBadgeProps) {
  const displayName = type === 'Purchasing' ? 'Buying' : 'Selling';
  const tooltipText =
    type === 'Purchasing'
      ? TOOLTIP_TEXTS.BUYING_WALLET_TYPE
      : TOOLTIP_TEXTS.SELLING_WALLET_TYPE;

  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
          type === 'Purchasing'
            ? 'bg-primary text-primary-foreground'
            : 'bg-orange-50 dark:bg-[#f002] text-orange-600 dark:text-orange-400',
        )}
      >
        {displayName}
      </span>
      {showTooltip && (
        <TooltipProvider delayDuration={100}>
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
              <p className="text-sm whitespace-pre-line">{tooltipText}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}
