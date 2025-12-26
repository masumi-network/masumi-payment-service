import { Skeleton } from '@/components/ui/skeleton';

export function AIAgentTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, index) => (
        <tr key={index} className="border-b">
          <td className="w-12 p-4">
            <Skeleton className="h-4 w-4" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-32" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-24" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-48" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-40" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-20" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-24" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-24" />
          </td>
          <td className="w-20 p-4">
            <Skeleton className="h-4 w-8" />
          </td>
        </tr>
      ))}
    </>
  );
}

