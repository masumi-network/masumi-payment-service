import { Skeleton } from '@/components/ui/skeleton';
import {
  tableActionsCellWideClass,
  tableActionsInnerClass,
} from '@/components/ui/table-actions-column';

export function QuarantineTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, index) => (
        <tr key={index} className="border-b last:border-b-0">
          <td className="w-10 p-4 pl-6">
            <Skeleton className="h-8 w-8 rounded-md" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-48" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-28" />
          </td>
          <td className="p-4">
            <Skeleton className="h-5 w-20 rounded-full" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-12" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-24" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-16" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-20" />
          </td>
          <td className={tableActionsCellWideClass}>
            <div className={tableActionsInnerClass}>
              <Skeleton className="h-8 w-16 rounded-md" />
              <Skeleton className="h-8 w-16 rounded-md" />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}
