import { Info } from 'lucide-react';
import { type ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Shared overview list: full-width rows, hairline dividers, flat hover (no inset pills). */
const overviewListRowBase =
  'min-h-[var(--overview-list-row-height)] w-full px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:hover:bg-transparent';

/** Single-line row (wallets). */
export const overviewListRowClass = cn(overviewListRowBase, 'flex items-center gap-4');

/** Two-line row (agents): primary row, then secondary text. */
export const overviewListRowStackClass = cn(overviewListRowBase, 'flex flex-col gap-1');

/** Wallet row: type column centered beside a two-line stack. */
export const overviewWalletListRowClass = cn(overviewListRowBase, 'flex items-stretch gap-4');

/** Secondary line under the primary row (description, wallet note). Keeps row height when empty. */
export const overviewListSecondaryLineClass =
  'min-h-4 truncate text-xs leading-4 text-muted-foreground';

/** Panel shell cap: header + list max + footer (`--overview-panel-max-height` in globals.css). */
export const overviewPanelHeightClass = 'min-h-overview-panel max-h-overview-panel';
export function DashboardPanel({
  title,
  description,
  headerExtra,
  children,
  footer,
  reserveListHeight = false,
}: {
  title: string;
  description: string;
  headerExtra?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Match list viewport height while loading or when showing rows (not empty). */
  reserveListHeight?: boolean;
}) {
  return (
    <section
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border bg-card',
        reserveListHeight && overviewPanelHeightClass,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-1">
          <h2 className="truncate text-base font-semibold leading-tight tracking-tight">{title}</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`About ${title}`}
              >
                <Info className="h-3.5 w-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              {description}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex h-8 shrink-0 items-center justify-end gap-1">{headerExtra}</div>
      </div>
      <div className={cn('flex min-h-0 flex-col', reserveListHeight && 'flex-1 overflow-hidden')}>
        {children}
      </div>
      {footer ? <div className="shrink-0 border-t bg-card px-4 py-3">{footer}</div> : null}
    </section>
  );
}

/** Fills panel body (flex-1); ~9 rows via panel max-height math. Load more at end of scroll. */
export const overviewListScrollClass = 'h-full min-h-0 overflow-y-auto overscroll-contain';

export function OverviewListScroll({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(overviewListScrollClass, className)}>{children}</div>;
}

export function OverviewList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn('m-0 list-none p-0', className)}>{children}</ul>;
}

export function OverviewListItem({ children, index }: { children: ReactNode; index: number }) {
  return (
    <li
      className="border-b border-border/50 last:border-b-0 animate-fade-in opacity-0"
      style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
    >
      {children}
    </li>
  );
}

export function OverviewListFootnote({ children }: { children: ReactNode }) {
  return <p className="px-4 pb-3 pt-2 text-xs text-muted-foreground">{children}</p>;
}

/** Fixed columns so wallet rows align: type | identity | balances. */
export const overviewWalletTypeColumnClass =
  'flex w-[5.5rem] shrink-0 self-center items-center gap-1.5 whitespace-nowrap text-xs font-medium leading-none text-muted-foreground';

export const overviewWalletBalanceColumnClass =
  'w-[5.75rem] shrink-0 text-right text-xs leading-snug tabular-nums';

export const overviewAgentPriceColumnClass =
  'w-[5.75rem] shrink-0 text-right text-xs tabular-nums text-muted-foreground';
