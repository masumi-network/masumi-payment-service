import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  learnMoreUrl?: string;
  children?: React.ReactNode;
  className?: string;
  extra?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  learnMoreUrl,
  children,
  className,
  extra,
}: PageHeaderProps) {
  return (
    <div className={cn('flex items-center justify-between', className)}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">
            {description}
            {learnMoreUrl && (
              <>
                {' '}
                <a href={learnMoreUrl} target="_blank" className="text-primary hover:underline">
                  Learn more
                </a>
              </>
            )}
          </p>
        )}
        {extra}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
