import { Skeleton } from '@/components/ui/skeleton';

export function AgentListSkeleton({ items = 3 }: { items?: number }) {
  return (
    <div className="mb-4 max-h-[500px] overflow-y-auto">
      {Array.from({ length: items }).map((_, index) => (
        <div
          key={index}
          className="flex items-center justify-between py-4 border-b last:border-0"
        >
          <div className="flex flex-col gap-1 max-w-[80%]">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

