/**
 * One callout, three tones.
 *
 * The same amber and red boxes were hand-written twenty times across these
 * screens, each with its own padding, its own icon or none, and its own idea of
 * what dark mode should look like. They drifted, as duplicated markup does: some
 * had an icon, some did not, two used a different border weight, and a warning
 * in one dialog did not look like a warning in the next.
 *
 * Tone is the only choice, and it is semantic rather than cosmetic: `warn` for
 * something the operator should know before acting, `error` for something that
 * already went wrong, `info` for a consequence worth stating. Colours come from
 * one place so they stay the same everywhere.
 */

import type { ReactNode } from 'react';
import { AlertTriangle, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'info' | 'warn' | 'error';

const TONES: Record<Tone, { box: string; icon: typeof Info }> = {
  info: {
    box: 'border-border bg-muted/40 text-muted-foreground',
    icon: Info,
  },
  warn: {
    box: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
    icon: AlertTriangle,
  },
  error: {
    box: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-400',
    icon: XCircle,
  },
};

export function HydraNotice({
  tone = 'info',
  children,
  /** Drop the icon where the text is a continuation rather than an alert. */
  plain = false,
  /** A button that resolves what the notice is about, kept on the same line. */
  action,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  plain?: boolean;
  action?: ReactNode;
  className?: string;
}) {
  const { box, icon: Icon } = TONES[tone];

  return (
    <div
      className={cn(
        'flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-xs',
        action && 'items-center justify-between gap-3',
        box,
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {!plain && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <div className="min-w-0 space-y-1">{children}</div>
      </div>
      {action}
    </div>
  );
}
