import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode } from 'react';

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

/** Matches `--overview-list-visible-rows` in globals.css. */
export const OVERVIEW_LIST_VISIBLE_ROWS = 8;

export const overviewPanelMaxHeightClass = 'max-h-overview-panel';
export const overviewPanelMinHeightClass = 'min-h-overview-panel';
export const overviewPanelCompactMinHeightClass = 'min-h-overview-panel-compact';

/** List body min height when panel matches empty-state size (see globals.css token). */
export const overviewPanelEmptyBodyClass = 'min-h-[var(--overview-panel-empty-body-min-height)]';

/** Side-by-side overview columns: match row height (mobile stacks without stretch). */
export const overviewPanelEqualHeightClass = 'lg:h-full';

export function DashboardPanel({
  title,
  titleHref,
  description,
  headerExtra,
  children,
  footer,
  reserveListHeight = false,
  fillListViewport = false,
}: {
  title: string;
  titleHref: string;
  description: string;
  headerExtra?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Cap list area and enable scroll layout when showing rows or loading. */
  reserveListHeight?: boolean;
  /** Reserve full list viewport (min height); use while loading or when row count >= visible rows. */
  fillListViewport?: boolean;
}) {
  return (
    <section
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border bg-card',
        overviewPanelEqualHeightClass,
        reserveListHeight && overviewPanelMaxHeightClass,
        fillListViewport && overviewPanelMinHeightClass,
        reserveListHeight && !fillListViewport && overviewPanelCompactMinHeightClass,
      )}
    >
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <Link
            href={titleHref}
            className="inline-flex max-w-full items-center gap-1 text-base font-semibold leading-tight tracking-tight hover:underline"
          >
            <span className="truncate">{title}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {headerExtra ? (
          <div className="flex h-8 shrink-0 items-center justify-end gap-1">{headerExtra}</div>
        ) : null}
      </div>
      <div
        className={cn(
          'flex min-h-0 flex-col lg:flex-1',
          reserveListHeight && !fillListViewport && overviewPanelEmptyBodyClass,
          reserveListHeight && fillListViewport && 'flex-1 overflow-hidden',
        )}
      >
        {children}
      </div>
      {footer ? <div className="shrink-0 border-t bg-card px-4 py-3">{footer}</div> : null}
    </section>
  );
}

/** Fills panel body when `fillListViewport`; load more at end of scroll. */
export const overviewListScrollClass = 'h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain';

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
      style={{ animationDelay: `${Math.min(index, OVERVIEW_LIST_VISIBLE_ROWS) * 40}ms` }}
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
