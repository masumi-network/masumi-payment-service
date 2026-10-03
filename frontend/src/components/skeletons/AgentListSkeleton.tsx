import { Skeleton } from '@/components/ui/skeleton';

export function AgentListSkeleton({ items = 3 }: { items?: number }) {
  return (
    <div>
      {Array.from({ length: items }).map((_, index) => (
        <div
          key={index}
          className="flex min-h-[var(--overview-list-row-height)] items-stretch gap-4 border-b border-border/50 px-4 py-3 last:border-b-0"
        >
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
            <Skeleton className="h-4 w-full max-w-xs" />
            <Skeleton className="h-4 w-full max-w-sm" />
          </div>
          <Skeleton className="my-auto h-4 w-[5.75rem] shrink-0" />
        </div>
      ))}
    </div>
  );
}
