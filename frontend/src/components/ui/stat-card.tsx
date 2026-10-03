import { Info } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme } from '@/lib/contexts/ThemeContext';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  children: React.ReactNode;
  className?: string;
  index?: number;
  icon?: React.ReactNode;
  accentColor?: string;
  labelTooltip?: string;
}

export function StatCard({
  label,
  children,
  className,
  index = 0,
  icon,
  accentColor,
  labelTooltip,
}: StatCardProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const accentMix = isDark ? 3 : 7;
  const cardBackground = accentColor
    ? `linear-gradient(to bottom right, hsl(var(--card)) ${isDark ? '72%' : '58%'}, color-mix(in srgb, ${accentColor} ${accentMix}%, hsl(var(--card))) 100%)`
    : `linear-gradient(to bottom right, hsl(var(--card)) 68%, hsl(var(--muted) / ${isDark ? '0.06' : '0.18'}) 100%)`;

  return (
    <div
      className={cn(
        'border rounded-lg bg-card p-6 card-interactive animate-fade-in-up opacity-0',
        className,
      )}
      style={{
        animationDelay: `${index * 75}ms`,
        borderLeftWidth: accentColor ? '4px' : undefined,
        borderLeftColor: accentColor || undefined,
        background: cardBackground,
      }}
    >
      <div className="flex items-center gap-3 mb-2">
        {icon && <span className="flex shrink-0 items-center">{icon}</span>}
        <div className="flex min-w-0 items-center gap-1">
          <div className="truncate text-sm text-muted-foreground">{label}</div>
          {labelTooltip ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`About ${label}`}
                >
                  <Info className="h-3.5 w-3.5" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                {labelTooltip}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div className="animate-number-reveal">{children}</div>
    </div>
  );
}
