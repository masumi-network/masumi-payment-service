import { cn } from '@/lib/utils';
import { SearchX, Inbox } from 'lucide-react';

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: 'search' | 'inbox';
  className?: string;
  action?: React.ReactNode;
}

export function EmptyState({
  title = 'No results found',
  description,
  icon = 'inbox',
  className,
  action,
}: EmptyStateProps) {
  const Icon = icon === 'search' ? SearchX : Inbox;

  return (
    <div className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
      <div className="mb-4">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-muted">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
      </div>
      <p className="text-sm font-medium text-muted-foreground animate-fade-in-up opacity-0">
        {title}
      </p>
      {description && (
        <p
          className="text-xs text-muted-foreground mt-1 animate-fade-in-up opacity-0"
          style={{ animationDelay: '75ms' }}
        >
          {description}
        </p>
      )}
      {action && (
        <div className="mt-4 animate-fade-in-up opacity-0" style={{ animationDelay: '150ms' }}>
          {action}
        </div>
      )}
    </div>
  );
}
