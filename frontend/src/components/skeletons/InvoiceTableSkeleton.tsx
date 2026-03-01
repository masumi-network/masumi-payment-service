import { Skeleton } from '@/components/ui/skeleton';

export function InvoiceTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, index) => (
        <tr key={index} className="border-b last:border-b-0">
          <td className="p-4 pl-6">
            <Skeleton className="h-4 w-24" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-28" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-28" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-20" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-12" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-8" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-16" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-16" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-16" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-16" />
          </td>
          <td className="p-4 pr-8">
            <Skeleton className="h-4 w-8" />
          </td>
        </tr>
      ))}
    </>
  );
}
