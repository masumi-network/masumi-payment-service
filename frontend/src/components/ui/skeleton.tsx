import { cn } from '@/lib/utils';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  isLoaded?: boolean;
  children?: React.ReactNode;
}

function Skeleton({ className, isLoaded, children, ...props }: SkeletonProps) {
  if (isLoaded && children !== undefined) {
    return <div className="animate-content-reveal">{children}</div>;
  }
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
