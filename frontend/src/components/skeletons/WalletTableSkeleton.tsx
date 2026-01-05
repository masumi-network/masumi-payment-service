import { Skeleton } from '@/components/ui/skeleton';

export function WalletTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, index) => (
        <tr key={index} className="border-b last:border-b-0">
          <td className="p-4">
            <Skeleton className="h-4 w-4" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-32" />
          </td>
          <td className="p-4">
            <Skeleton className="h-4 w-48" />
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
