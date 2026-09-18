import { Skeleton } from '@/components/ui/skeleton';
import {
  tableActionsCellCompactClass,
  tableActionsInnerClass,
} from '@/components/ui/table-actions-column';

export function TransactionTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, index) => (
        <tr key={index} className="border-b last:border-b-0">
          <td className="p-4">
            <Skeleton className="h-4 w-16" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-48" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-36" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-24" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-20" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-24" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-32" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-32" />
          </td>
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
