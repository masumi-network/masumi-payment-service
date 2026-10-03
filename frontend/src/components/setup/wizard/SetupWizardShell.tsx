import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Shared frame for the Cardano `/setup` and x402 `/x402-setup` wizards.
 *
 * Screen 0 is the welcome card and the last screen is the success card; only the screens in
 * between are numbered, so `stepLabels` lists just those. The shell owns the stepper, the
 * direction-aware screen transition and focus: after a step change it moves focus to the new
 * screen's heading, so keyboard and screen-reader users land at the top of the new step
 * instead of on `<body>` (the clicked button unmounts with the old screen).
 */
export function SetupWizardShell({
  stepLabels,
  currentStep,
  children,
}: {
  /** Labels of the numbered steps only (welcome and success screens excluded). */
  stepLabels: string[];
  /** 0 = welcome, 1..stepLabels.length = numbered steps, stepLabels.length + 1 = success. */
  currentStep: number;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasMountedRef = useRef(false);
  // Previous-value tracking during render (not in a ref) so the slide direction is known on
  // the same render that swaps the screen.
  const [previousStep, setPreviousStep] = useState(currentStep);
  const [isBack, setIsBack] = useState(false);
  if (previousStep !== currentStep) {
    setIsBack(currentStep < previousStep);
    setPreviousStep(currentStep);
  }
  const showStepper = currentStep > 0 && currentStep <= stepLabels.length;

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    const heading = containerRef.current?.querySelector<HTMLElement>('h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [currentStep]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4">
      {showStepper && <SetupStepper labels={stepLabels} currentStep={currentStep} />}
      <div
        ref={containerRef}
        className={cn(
          'flex flex-col items-center pb-8',
          showStepper ? 'pt-2' : 'min-h-[calc(100vh-160px)] justify-center pt-8',
        )}
      >
        <div
          key={currentStep}
          className={cn('w-full', isBack ? 'animate-slide-in-left' : 'animate-slide-in-right')}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** Numbered progress for the middle steps of a setup wizard. */
export function SetupStepper({ labels, currentStep }: { labels: string[]; currentStep: number }) {
  return (
    <nav aria-label="Setup progress" className="pb-6 pt-2">
      <p className="sr-only" aria-live="polite">
        Step {currentStep} of {labels.length}: {labels[currentStep - 1]}
      </p>
      <ol className="flex items-start gap-2">
        {labels.map((label, index) => {
          const stepNumber = index + 1;
          const isComplete = currentStep > stepNumber;
          const isCurrent = currentStep === stepNumber;
          return (
            <li
              key={label}
              aria-current={isCurrent ? 'step' : undefined}
              className="flex min-w-0 flex-1 flex-col gap-2"
            >
              <span
                aria-hidden
                className={cn(
                  'h-1 rounded-full transition-[background-color] duration-300',
                  isComplete || isCurrent ? 'bg-primary' : 'bg-muted',
                )}
              />
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <span
                  aria-hidden
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums transition-[background-color,color] duration-150',
                    isComplete || isCurrent
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border text-foreground/70',
                  )}
                >
                  {isComplete ? <Check className="size-2.5" strokeWidth={3} /> : stepNumber}
                </span>
                <span
                  className={cn(
                    'truncate',
                    isCurrent ? 'font-medium text-foreground' : 'text-foreground/70',
                  )}
                >
                  {label}
                  {isComplete && <span className="sr-only"> (completed)</span>}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
