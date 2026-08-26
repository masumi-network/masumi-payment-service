import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ReportChartRow } from '@/lib/transaction-report/chart-data';
import {
  paginateReportRows,
  resetReportTablePageState,
  type ReportTablePageState,
} from '@/lib/transaction-report/report-rendering';
import { ReportTablePagination } from '../ReportTablePagination';
import type { ReportChartSeries } from './ReportChart';
import { EstimateDot } from './ReportCompleteness';

/**
 * The exact numbers behind a chart. Collapsed by default: the chart answers
 * "what is the shape", this answers "what was the figure on that day".
 */
export function ReportHistoryTable({
  rows,
  series,
  label,
}: Readonly<{
  rows: readonly ReportChartRow[];
  series: readonly ReportChartSeries[];
  label: string;
}>) {
  const [isOpen, setIsOpen] = useState(false);
  const [pageState, setPageState] = useState<ReportTablePageState>(() => ({
    dataset: rows,
    page: 0,
  }));
  const currentPageState = resetReportTablePageState(pageState, rows);
  if (currentPageState !== pageState) setPageState(currentPageState);

  if (rows.length === 0) return null;

  const page = paginateReportRows(rows, currentPageState.page);

  return (
    <div className="mt-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto px-2 py-1 text-xs text-muted-foreground"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-180')} />
        {isOpen ? 'Hide the numbers' : 'Show the numbers'}
      </Button>

      {isOpen && (
        <div className="mt-2 rounded-lg border">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">{label}</caption>
              <thead className="bg-muted/30 text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Period
                  </th>
                  {series.map((entry) => (
                    <th key={entry.key} scope="col" className="px-3 py-2 text-right font-medium">
                      {entry.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.items.map((row) => (
                  <tr key={row.bucketTitle} className="border-t">
                    <th scope="row" className="whitespace-nowrap px-3 py-2 font-medium">
                      {row.bucketTitle}
                    </th>
                    {series.map((entry) => (
                      <td
                        key={entry.key}
                        className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums"
                      >
                        {row[entry.key] == null ? (
                          <span className="text-muted-foreground">Not known</span>
                        ) : (
                          <span className="inline-flex items-start gap-1">
                            {row.bucketTexts[entry.key] ?? '—'}
                            {row.bucketPartial && <EstimateDot />}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ReportTablePagination
            page={page.page}
            pageCount={page.pageCount}
            startIndex={page.startIndex}
            endIndex={page.endIndex}
            totalCount={page.totalCount}
            itemLabel="periods"
            ariaLabel={`${label} pagination`}
            onPageChange={(nextPage) => setPageState({ dataset: rows, page: nextPage })}
          />
        </div>
      )}
    </div>
  );
}
