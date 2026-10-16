import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  tableActionsCellCompactClass,
  tableActionsInnerClass,
} from '@/components/ui/table-actions-column';

// Placeholder bar widths for the leading data columns, in order. Shorter than
// the maximum column count on purpose: cells past the end fall back to a
// neutral width, since a shimmer only has to line the row up, not match every
// real column's content.
const CELL_WIDTHS = ['w-32', 'w-24', 'w-48', 'w-40', 'w-20', 'w-24', 'w-24'];

/**
 * Loading rows for the AI-agents and inbox-agents tables. `columns` must match
 * the host table's header cell count or the shimmer sits offset from the real
 * rows; it counts the trailing compact actions column too. Defaults to 8 for the
 * inbox table, while the AI-agents table passes 9 (it also renders Type).
 */
export function AIAgentTableSkeleton({
  rows = 5,
  columns = 8,
  withSelectionColumn = false,
}: {
  rows?: number;
  columns?: number;
  withSelectionColumn?: boolean;
}) {
  const dataColumnCount = Math.max(columns - 1 - (withSelectionColumn ? 1 : 0), 0);

  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} className="border-b">
          {withSelectionColumn ? (
            <td className="w-12 p-4">
              <Skeleton className="h-4 w-4" />
            </td>
          ) : null}
          {Array.from({ length: dataColumnCount }).map((_, cellIndex) => (
            <td
              key={cellIndex}
              className={cn('p-4', !withSelectionColumn && cellIndex === 0 && 'pl-6')}
            >
              <Skeleton className={`h-4 ${CELL_WIDTHS[cellIndex] ?? 'w-24'}`} />
            </td>
          ))}
          <td className={tableActionsCellCompactClass}>
            <div className={tableActionsInnerClass}>
              <Skeleton className="h-8 w-8 rounded-md" />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}
