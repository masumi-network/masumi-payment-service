import { type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type BulkActionBarProps = {
  selectedCount: number;
  onClear: () => void;
  disabled?: boolean;
  variant?: 'default' | 'destructive';
  className?: string;
  children: ReactNode;
};

export function BulkActionBar({
  selectedCount,
  onClear,
  disabled = false,
  variant = 'default',
  className,
  children,
}: BulkActionBarProps) {
  if (selectedCount <= 0) return null;

  return (
    <div
      className={cn(
        'flex animate-fade-in items-center justify-between gap-4 rounded-lg border px-4 py-2',
        variant === 'destructive'
          ? 'border-destructive/30 bg-destructive/5'
          : 'border-border bg-muted/30',
        className,
      )}
    >
      <span className="text-sm font-medium">{selectedCount} selected</span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClear} disabled={disabled}>
          Clear
        </Button>
        {children}
      </div>
    </div>
  );
}
