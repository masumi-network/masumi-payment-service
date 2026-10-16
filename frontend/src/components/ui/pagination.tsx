import { cn } from '@/lib/utils';
import { Button } from './button';
import { Spinner } from './spinner';

interface PaginationProps {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  className?: string;
  size?: 'default' | 'compact';
}

export function Pagination({
  hasMore,
  isLoading,
  onLoadMore,
  className = '',
  size = 'default',
}: PaginationProps) {
  const isCompact = size === 'compact';
  if (!hasMore && !isLoading) {
    return (
      <div className={`flex justify-center ${className}`}>
        <span className="text-xs text-muted-foreground/60">End of results</span>
      </div>
    );
  }

  return (
    <div className={`flex justify-center space-x-2 ${className}`}>
      <Button
        variant="outline"
        size="sm"
        className={cn(
          'btn-hover-lift relative overflow-hidden',
          isCompact ? 'h-7 min-h-7 px-2.5 text-xs' : 'min-w-25',
        )}
        onClick={onLoadMore}
        disabled={!hasMore || isLoading}
      >
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center gap-1.5 transition-all duration-200',
            isLoading ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-full',
          )}
        >
          <Spinner size={isCompact ? 12 : 14} />
          <span className={isCompact ? 'text-xs' : undefined}>Loading...</span>
        </span>
        <span
          className={cn(
            'transition-all duration-200',
            isLoading ? 'opacity-0 -translate-y-full' : 'opacity-100 translate-y-0',
          )}
        >
          Load More
        </span>
      </Button>
    </div>
  );
}
