import type { ComponentProps } from 'react';

import { useDragToScroll } from '@/lib/hooks/useDragToScroll';
import { cn } from '@/lib/utils';

export function HorizontalScrollArea({ className, children, ...props }: ComponentProps<'div'>) {
  const { ref, isScrollable, isDragging } = useDragToScroll();

  return (
    <div
      ref={ref}
      className={cn(
        'overflow-x-auto',
        isScrollable && (isDragging ? 'cursor-grabbing select-none' : 'cursor-grab'),
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
