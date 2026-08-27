export const REPORT_TABLE_PAGE_SIZE = 50;

export type ReportRowPage<T> = Readonly<{
  items: readonly T[];
  page: number;
  pageCount: number;
  startIndex: number;
  endIndex: number;
  totalCount: number;
}>;

export type ReportTablePageState = Readonly<{
  dataset: object;
  page: number;
}>;

export function resetReportTablePageState(
  state: ReportTablePageState,
  dataset: object,
): ReportTablePageState {
  return state.dataset === dataset ? state : { dataset, page: 0 };
}

export function paginateReportRows<T>(
  rows: readonly T[],
  requestedPage: number,
  requestedPageSize = REPORT_TABLE_PAGE_SIZE,
): ReportRowPage<T> {
  const pageSize = Math.max(1, Math.floor(requestedPageSize));
  const pageCount = Math.ceil(rows.length / pageSize);
  const page =
    pageCount === 0 ? 0 : Math.min(Math.max(0, Math.floor(requestedPage)), pageCount - 1);
  const startIndex = page * pageSize;
  const endIndex = Math.min(startIndex + pageSize, rows.length);
  return {
    items: rows.slice(startIndex, endIndex),
    page,
    pageCount,
    startIndex,
    endIndex,
    totalCount: rows.length,
  };
}
