import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RefreshButtonProps {
  onRefresh: () => void | Promise<void>;
  isRefreshing?: boolean;
  disabled?: boolean;
  variant?: 'icon-only' | 'with-text';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function RefreshButton({
  onRefresh,
  isRefreshing = false,
  disabled = false,
  variant = 'icon-only',
  size = 'sm',
  className,
}: RefreshButtonProps) {
  const isDisabled = disabled || isRefreshing;

  const sizeClasses = {
    sm: 'h-8 w-8',
    md: 'h-9 w-9',
    lg: 'h-10 w-10',
  };

  const iconSizes = {
    sm: 'h-4 w-4',
    md: 'h-4 w-4',
    lg: 'h-5 w-5',
  };

  const textSizes = {
    sm: 'text-sm',
    md: 'text-sm',
    lg: 'text-base',
  };

  if (variant === 'icon-only') {
    return (
      <Button
        variant="outline"
        size="icon"
        onClick={onRefresh}
        disabled={isDisabled}
        className={cn(sizeClasses[size], isRefreshing && 'cursor-not-allowed', className)}
        title={isRefreshing ? 'Refreshing...' : 'Refresh'}
      >
        <RefreshCw
          className={cn(iconSizes[size], isRefreshing && 'animate-spin')}
          style={isRefreshing ? { animationDuration: '1s' } : undefined}
        />
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      onClick={onRefresh}
      disabled={isDisabled}
      className={cn('flex items-center gap-2', isRefreshing && 'cursor-not-allowed', className)}
      title={isRefreshing ? 'Refreshing...' : 'Refresh'}
    >
      <RefreshCw
        className={cn(iconSizes[size], isRefreshing && 'animate-spin')}
        style={isRefreshing ? { animationDuration: '1s' } : undefined}
      />
      <span className={textSizes[size]}>Refresh</span>
    </Button>
  );
}
