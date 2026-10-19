/**
 * One page of the rows loaded so far.
 *
 * The server sends a head's lists a batch at a time, newest first, and the
 * browser pages through what has arrived. A page is a start offset, not a page
 * number, so it can stay on the same rows while new ones land above it. A start
 * past the end moves back to the last full page of rows. A list shrinks under
 * the reader (clearing errors would otherwise leave an empty page with a pager
 * that says "4 of 2"), and Next past the loaded rows keeps the rows on screen
 * until the next batch lands.
 */

/** Rows per page for a head's errors and transactions. */
export const LIST_PAGE_SIZE = 10;
/** Deposits and withdrawals sit under a form, so they page shorter. */
export const HISTORY_PAGE_SIZE = 5;

export type Page<T> = {
  items: T[];
  /** Zero-based offset of the first row shown, after clamping. */
  start: number;
  /** Zero-based page number: how many pages fit before `start`. */
  page: number;
  pageCount: number;
  /** One-based position of the first row shown, 0 when the list is empty. */
  from: number;
  /** One-based position of the last row shown. */
  to: number;
  total: number;
  pageSize: number;
};

export function pageOf<T>(items: readonly T[], start: number, pageSize: number): Page<T> {
  const total = items.length;
  const clamped = start >= total ? Math.max(0, total - pageSize) : Math.max(0, start);
  const slice = items.slice(clamped, clamped + pageSize);
  const pagesBefore = Math.ceil(clamped / pageSize);
  const pagesAfter = Math.max(0, Math.ceil((total - clamped - pageSize) / pageSize));
  return {
    items: slice,
    start: clamped,
    page: pagesBefore,
    pageCount: pagesBefore + 1 + pagesAfter,
    from: total === 0 ? 0 : clamped + 1,
    to: clamped + slice.length,
    total,
    pageSize,
  };
}

/**
 * Where the reader is: an offset, and the row the page started on.
 *
 * The lists poll, and a new row arrives at the top. Paging by offset alone
 * would then shift every page down by one and show one row twice. Following
 * the row the page started on keeps the reader on the same rows.
 */
export type PagePosition = { start: number; anchorId: string | null };

export function startOf<T extends { id: string }>(
  items: readonly T[],
  position: PagePosition,
): number {
  if (position.anchorId === null) return position.start;
  const anchored = items.findIndex((item) => item.id === position.anchorId);
  return anchored >= 0 ? anchored : position.start;
}

/**
 * The position one page forward or back.
 *
 * The first page has no anchor, so new rows show on it. A page past the loaded
 * rows has none yet either: it is anchored once its first row arrives.
 */
export function movedPosition<T extends { id: string }>(
  items: readonly T[],
  start: number,
  pageSize: number,
  direction: 1 | -1,
): PagePosition {
  const next = Math.max(0, start + direction * pageSize);
  return { start: next, anchorId: next === 0 ? null : (items[next]?.id ?? null) };
}
