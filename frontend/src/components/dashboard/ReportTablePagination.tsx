import { Button } from '@/components/ui/button';

type ReportTablePaginationProps = Readonly<{
  page: number;
  pageCount: number;
  startIndex: number;
  endIndex: number;
  totalCount: number;
  itemLabel: string;
  ariaLabel: string;
  onPageChange: (page: number) => void;
}>;

export function ReportTablePagination({
  page,
  pageCount,
  startIndex,
  endIndex,
  totalCount,
  itemLabel,
  ariaLabel,
  onPageChange,
}: ReportTablePaginationProps) {
  if (pageCount <= 1) return null;

  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs"
      aria-label={ariaLabel}
    >
      <span aria-live="polite">
        Showing {startIndex + 1} to {endIndex} of {totalCount} {itemLabel}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm2"
          onClick={() => onPageChange(page - 1)}
          disabled={page === 0}
        >
          Previous
        </Button>
        <span>
          Page {page + 1} of {pageCount}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm2"
          onClick={() => onPageChange(page + 1)}
          disabled={page + 1 >= pageCount}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
