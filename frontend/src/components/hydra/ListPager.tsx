/**
 * Prev / next for a list paged in the browser.
 *
 * The rows come from the server a batch at a time. When the reader pages past
 * the last loaded row and the server has more, Next asks for the next batch and
 * the page fills in when it lands. Renders nothing for a list that fits on one
 * page with nothing more to load, so short lists carry no controls.
 */

import { useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { movedPosition, pageOf, startOf, type Page, type PagePosition } from './paging';

export function usePagedList<T extends { id: string }>(items: readonly T[], pageSize: number) {
  const [position, setPosition] = useState<PagePosition>({ start: 0, anchorId: null });
  const current = pageOf(items, startOf(items, position), pageSize);

  // A page asked for before its rows loaded is anchored once they arrive.
  const pendingAnchorId =
    position.anchorId === null && position.start > 0 ? (items[position.start]?.id ?? null) : null;
  // Set during render, React's pattern for state derived from new props: it
  // re-renders before painting, and the condition is false on the next pass.
  if (pendingAnchorId !== null) {
    setPosition({ ...position, anchorId: pendingAnchorId });
  }

  return {
    ...current,
    move: (direction: 1 | -1) =>
      setPosition(movedPosition(items, current.start, pageSize, direction)),
  };
}

export function ListPager({
  page,
  more,
  className,
}: {
  page: Pick<Page<unknown>, 'page' | 'pageCount' | 'from' | 'to' | 'total' | 'pageSize'> & {
    move: (direction: 1 | -1) => void;
  };
  /** The server side of the list, when it has rows not loaded yet. */
  more?: { hasMore: boolean; isLoadingMore: boolean; loadMore: () => void };
  className?: string;
}) {
  const hasMore = more?.hasMore === true;
  if (page.pageCount <= 1 && !hasMore) return null;
  const isLastLoadedPage = page.to >= page.total;

  function handleNext() {
    if (isLastLoadedPage) {
      more?.loadMore();
      // A short last page is filled in by the batch being loaded, so stay on
      // it. Moving on would skip the rows that land on this page.
      if (page.to - page.from + 1 < page.pageSize) return;
    }
    page.move(1);
  }

  return (
    <div className={className ?? 'flex items-center justify-between gap-2 pt-1'}>
      <span className="text-xs tabular-nums text-muted-foreground">
        {page.from}-{page.to} of {page.total}
        {hasMore ? '+' : ''}
      </span>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Previous page"
          disabled={page.from <= 1}
          onClick={() => page.move(-1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
          {page.page + 1} / {page.pageCount}
          {hasMore ? '+' : ''}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Next page"
          disabled={(isLastLoadedPage && !hasMore) || more?.isLoadingMore === true}
          onClick={handleNext}
        >
          {more?.isLoadingMore ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
