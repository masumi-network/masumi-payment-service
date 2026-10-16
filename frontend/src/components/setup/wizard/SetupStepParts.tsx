import { useId, type ReactNode } from 'react';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Title block for one setup step: icon, the screen's single `<h1>`, an optional badge and a
 * one-line description. `SetupWizardShell` focuses this heading after every step change.
 */
export function SetupStepHeader({
  icon: Icon,
  title,
  description,
  badge,
  iconClassName = 'text-primary',
  iconRingClassName = 'from-primary/20 to-primary/5 ring-primary/20',
}: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  iconClassName?: string;
  iconRingClassName?: string;
}) {
  return (
    <div className="space-y-3 text-center">
      <div
        className={cn(
          'inline-flex items-center justify-center rounded-full bg-gradient-to-br p-3 ring-1',
          iconRingClassName,
        )}
      >
        <Icon className={cn('size-6', iconClassName)} aria-hidden />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <h1 className="text-balance text-2xl font-bold tracking-tight outline-none">{title}</h1>
        {badge}
      </div>
      {description && (
        <p className="mx-auto max-w-md text-pretty text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

/**
 * Footer for a setup step: a quiet back/cancel action and the primary action. When the
 * primary action is disabled, `blockedReason` is shown as visible text and linked to the
 * button, because a disabled button cannot take focus and a `title` tooltip never shows.
 */
export function SetupStepActions({
  backLabel = 'Back',
  onBack,
  primaryLabel,
  onPrimary,
  isPrimaryDisabled = false,
  isPrimaryBusy = false,
  primaryType = 'button',
  blockedReason,
  secondary,
}: {
  backLabel?: string;
  onBack?: () => void;
  primaryLabel: ReactNode;
  onPrimary?: () => void;
  isPrimaryDisabled?: boolean;
  isPrimaryBusy?: boolean;
  primaryType?: 'button' | 'submit';
  blockedReason?: ReactNode;
  /** Optional extra action rendered before the primary button (for example "Skip for now"). */
  secondary?: ReactNode;
}) {
  const reasonId = useId();
  const showReason = isPrimaryDisabled && !isPrimaryBusy && !!blockedReason;

  return (
    <div className="space-y-2 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {onBack ? (
          <Button type="button" variant="ghost" onClick={onBack}>
            {backLabel}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-2">
          {secondary}
          <Button
            type={primaryType}
            onClick={onPrimary}
            disabled={isPrimaryDisabled || isPrimaryBusy}
            aria-describedby={showReason ? reasonId : undefined}
            className="group gap-2 pe-3.5"
          >
            {primaryLabel}
            <ArrowRight
              className="size-4 transition-[translate] duration-150 group-hover:translate-x-0.5"
              aria-hidden
            />
          </Button>
        </div>
      </div>
      {showReason && (
        <p id={reasonId} className="text-end text-xs text-muted-foreground">
          {blockedReason}
        </p>
      )}
    </div>
  );
}
