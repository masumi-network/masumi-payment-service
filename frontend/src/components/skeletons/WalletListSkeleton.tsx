import { Skeleton } from '@/components/ui/skeleton';

export function WalletListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="mb-4 max-h-[500px] overflow-y-auto overflow-x-auto w-full">
      <table className="w-full">
        <thead className="sticky top-0 bg-background z-10">
          <tr className="text-sm text-muted-foreground border-b">
            <th className="text-left py-2 px-2 w-20">Type</th>
            <th className="text-left py-2 px-2">Address</th>
            <th className="text-left py-2 px-2 w-32">Balance</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, index) => (
            <tr key={index} className="border-b last:border-0">
              <td className="py-3 px-2">
                <Skeleton className="h-4 w-16" />
              </td>
              <td className="py-3 px-2">
                <Skeleton className="h-4 w-48" />
              </td>
              <td className="py-3 px-2">
                <Skeleton className="h-4 w-24" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

