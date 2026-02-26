import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  children: React.ReactNode;
  className?: string;
  index?: number;
  icon?: React.ReactNode;
  accentColor?: string;
}

export function StatCard({
  label,
  children,
  className,
  index = 0,
  icon,
  accentColor,
}: StatCardProps) {
  return (
    <div
      className={cn(
        'border rounded-lg p-6 card-interactive animate-fade-in-up opacity-0',
        className,
      )}
      style={{
        animationDelay: `${index * 75}ms`,
        borderLeftWidth: accentColor ? '4px' : undefined,
        borderLeftColor: accentColor || undefined,
      }}
    >
      <div className="flex items-center gap-3 mb-2">
        {icon && (
          <div
            className="flex items-center justify-center w-8 h-8 rounded-full"
            style={{ backgroundColor: accentColor ? `${accentColor}15` : undefined }}
          >
            {icon}
          </div>
        )}
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>
      <div className="animate-number-reveal">{children}</div>
    </div>
  );
}
