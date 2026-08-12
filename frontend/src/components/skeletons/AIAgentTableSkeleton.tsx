import { Skeleton } from '@/components/ui/skeleton';

// Placeholder bar widths for the leading data columns, in order. Shorter than
// the maximum column count on purpose: cells past the end fall back to a
// neutral width, since a shimmer only has to line the row up, not match every
// real column's content.
const CELL_WIDTHS = ['w-32', 'w-24', 'w-48', 'w-40', 'w-20', 'w-24', 'w-24'];

/**
 * Loading rows for the AI-agents and inbox-agents tables. `columns` must match
 * the host table's header cell count or the shimmer sits offset from the real
 * rows; it counts the trailing narrow actions column too. Defaults to 8 for the
 * inbox table, while the AI-agents table passes 9 (it also renders Type).
 */
export function AIAgentTableSkeleton({
  rows = 5,
  columns = 8,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} className="border-b">
          {Array.from({ length: Math.max(columns - 1, 0) }).map((_, cellIndex) => (
            <td key={cellIndex} className="p-4">
              <Skeleton className={`h-4 ${CELL_WIDTHS[cellIndex] ?? 'w-24'}`} />
            </td>
          ))}
          <td className="w-20 p-4">
            <Skeleton className="h-4 w-8" />
          </td>
        </tr>
      ))}
    </>
  );
}
