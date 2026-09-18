import { Skeleton } from '@/components/ui/skeleton';

export function WalletListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex min-h-[var(--overview-list-row-height)] items-stretch gap-4 border-b border-border/50 px-4 py-3 last:border-b-0"
        >
          <Skeleton className="my-auto h-4 w-[5.5rem] shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex w-full items-baseline gap-4">
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <Skeleton className="h-4 min-w-0 flex-1 max-w-[14rem]" />
                <Skeleton className="h-4 w-4 shrink-0 rounded-md" />
              </div>
              <Skeleton className="ml-auto h-4 w-[5.75rem] shrink-0" />
            </div>
            <div className="flex w-full gap-4">
              <Skeleton className="h-4 min-w-0 flex-1 max-w-[8rem]" />
              <Skeleton className="ml-auto h-4 w-[5.75rem] shrink-0" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
