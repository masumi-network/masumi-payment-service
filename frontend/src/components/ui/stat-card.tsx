import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  children: React.ReactNode;
  className?: string;
  index?: number;
}

export function StatCard({ label, children, className, index = 0 }: StatCardProps) {
  return (
    <div
      className={cn(
        'border rounded-lg p-6 card-interactive animate-fade-in-up opacity-0',
        className,
      )}
      style={{ animationDelay: `${index * 75}ms` }}
    >
      <div className="text-sm text-muted-foreground mb-2">{label}</div>
      <div className="animate-number-reveal">{children}</div>
    </div>
  );
}
