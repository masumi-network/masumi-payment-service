import { Skeleton } from '@/components/ui/skeleton';

export function StatCardSkeleton() {
  return (
    <div className="rounded-lg border bg-gradient-to-br from-card via-card to-muted/30 p-6 dark:to-muted/10">
      <Skeleton className="h-4 w-24 mb-2" />
      <Skeleton className="h-8 w-32" />
    </div>
  );
}
