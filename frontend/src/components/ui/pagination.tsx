import { cn } from '@/lib/utils';
import { Button } from './button';
import { Spinner } from './spinner';

interface PaginationProps {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  className?: string;
}

export function Pagination({ hasMore, isLoading, onLoadMore, className = '' }: PaginationProps) {
  return (
    <div className={`flex justify-center space-x-2 ${className}`}>
      <Button
        variant="outline"
        size="sm"
        className="btn-hover-lift min-w-25 relative overflow-hidden"
        onClick={onLoadMore}
        disabled={!hasMore || isLoading}
      >
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center gap-2 transition-all duration-200',
            isLoading ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-full',
          )}
        >
          <Spinner size={14} />
          <span>Loading...</span>
        </span>
        <span
          className={cn(
            'transition-all duration-200',
            isLoading ? 'opacity-0 -translate-y-full' : 'opacity-100 translate-y-0',
          )}
        >
          {hasMore ? 'Load More' : 'No More Data'}
        </span>
      </Button>
    </div>
  );
}
