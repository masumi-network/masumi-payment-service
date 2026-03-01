import { cn } from '@/lib/utils';

interface AnimatedPageProps {
  children: React.ReactNode;
  className?: string;
}

export function AnimatedPage({ children, className }: AnimatedPageProps) {
  return <div className={cn('animate-page-enter', className)}>{children}</div>;
}
