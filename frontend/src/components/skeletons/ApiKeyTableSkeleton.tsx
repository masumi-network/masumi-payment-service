import { Skeleton } from '@/components/ui/skeleton';
import {
  tableActionsCellCompactClass,
  tableActionsInnerClass,
} from '@/components/ui/table-actions-column';
import { TableCell, TableRow } from '@/components/ui/table';

export function ApiKeyTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="w-12 p-4">
            <Skeleton className="h-4 w-4" />
          </TableCell>
          <TableCell className="p-4">
            <Skeleton className="h-4 w-24" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-32" />
          </TableCell>
          <TableCell>
            <div className="flex gap-1">
              <Skeleton className="h-5 w-14 rounded-full" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-20" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-5 w-14 rounded-full" />
          </TableCell>
          <TableCell className={tableActionsCellCompactClass}>
            <div className={tableActionsInnerClass}>
              <Skeleton className="h-8 w-8 rounded-md" />
            </div>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}
