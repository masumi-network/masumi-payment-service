import type { ComponentPropsWithoutRef } from 'react';

import { useDragToScroll } from '@/lib/hooks/useDragToScroll';
import { cn } from '@/lib/utils';

export function HorizontalScrollArea({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'div'>) {
  const { ref, isScrollable, isDragging } = useDragToScroll();

  return (
    <div
      {...props}
      ref={ref}
      className={cn(
        '@container/table-scroll overflow-x-auto',
        isScrollable && (isDragging ? 'cursor-grabbing select-none' : 'cursor-grab'),
        className,
      )}
    >
      {children}
    </div>
  );
}
