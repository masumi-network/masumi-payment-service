import { walletOverviewTableClassName } from '@/components/dashboard/dashboard-wallet-list-section';
import { Skeleton } from '@/components/ui/skeleton';

const thClass = 'px-3 py-2';
const tdClass = 'px-3 py-3';

export function WalletListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <table className={walletOverviewTableClassName}>
      <thead className="sticky top-0 z-20 bg-card [&_tr]:border-b [&_tr]:border-border/50">
        <tr>
          {['Type', 'Name', 'Address', 'Balance', 'Actions'].map((label) => (
            <th key={label} scope="col" className={thClass}>
              <Skeleton className="h-3 w-12" />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, index) => (
          <tr key={index} className="border-b border-border/50 last:border-b-0">
            <td className={tdClass}>
              <Skeleton className="h-6 w-20" />
            </td>
            <td className={tdClass}>
              <Skeleton className="mb-1 h-4 w-32" />
              <Skeleton className="h-3 w-40" />
            </td>
            <td className={tdClass}>
              <Skeleton className="h-4 w-28" />
            </td>
            <td className={tdClass}>
              <Skeleton className="mb-1 ml-auto h-3 w-20" />
              <Skeleton className="ml-auto h-3 w-16" />
            </td>
            <td className={tdClass}>
              <Skeleton className="ml-auto h-8 w-24" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
