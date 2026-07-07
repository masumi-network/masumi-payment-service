import { useState } from 'react';
import { cn } from '@/lib/utils';

interface AnimatedPageProps {
  children: React.ReactNode;
  className?: string;
}

// Module-level so it survives client-side navigations (but resets on a full
// reload / fresh JS context). The entrance fade should play once when the app
// first loads; replaying it on every in-app navigation makes each route change
// feel like a full page reload instead of a continuous transition.
let hasPlayedEntrance = false;

export function AnimatedPage({ children, className }: AnimatedPageProps) {
  const [animate] = useState(() => {
    if (hasPlayedEntrance) return false;
    hasPlayedEntrance = true;
    return true;
  });
  return <div className={cn(animate && 'animate-page-enter', className)}>{children}</div>;
}
