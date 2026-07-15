import { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export interface WizardStep {
  /** Stable identifier, useful for switch-rendering step content. */
  id: string;
  /** Shown in the progress indicator. */
  title: string;
  /**
   * Blocks "next" while false. Omit for always-navigable steps; run
   * form validation in onNext instead when validation is async.
   */
  canProceed?: boolean;
  /** Hide the back button on this step (e.g. after an irreversible action). */
  hideBack?: boolean;
}

/**
 * Controlled multi-step wizard chrome: progress indicator + step content +
 * back/next/finish wiring. The parent owns the step index and renders the
 * current step's content as children, so step content stays fully flexible.
 *
 * Designed to replace the hand-rolled step state in SetupWelcome,
 * MigrateAgentsDialog and GenerateInvoiceDialog:
 *
 *   const [step, setStep] = useState(0);
 *   <StepWizard
 *     steps={steps}
 *     currentStep={step}
 *     onStepChange={setStep}
 *     onFinish={handleSubmit}
 *     isBusy={isSubmitting}
 *   >
 *     {step === 0 && <SelectAgents ... />}
 *     ...
 *   </StepWizard>
 */
export function StepWizard({
  steps,
  currentStep,
  onStepChange,
  onFinish,
  isBusy,
  finishLabel = 'Finish',
  nextLabel = 'Next',
  backLabel = 'Back',
  children,
}: {
  steps: WizardStep[];
  currentStep: number;
  onStepChange: (step: number) => void;
  /** Called when "next" is pressed on the final step. */
  onFinish: () => void;
  /** Disables navigation and shows a spinner on the primary button. */
  isBusy?: boolean;
  finishLabel?: string;
  nextLabel?: string;
  backLabel?: string;
  children: ReactNode;
}) {
  const step = steps[currentStep];
  const isLast = currentStep === steps.length - 1;
  const canProceed = step?.canProceed ?? true;

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex items-center gap-2" aria-label="Progress">
        {steps.map((s, index) => (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium',
                index < currentStep && 'bg-primary text-primary-foreground',
                index === currentStep && 'border-2 border-primary text-primary',
                index > currentStep && 'border border-muted-foreground/40 text-muted-foreground',
              )}
              aria-current={index === currentStep ? 'step' : undefined}
            >
              {index + 1}
            </span>
            <span
              className={cn(
                'text-xs',
                index === currentStep ? 'font-medium' : 'text-muted-foreground',
              )}
            >
              {s.title}
            </span>
            {index < steps.length - 1 && <span className="h-px w-4 bg-muted-foreground/40" />}
          </li>
        ))}
      </ol>

      <div>{children}</div>

      <div className="flex justify-between">
        <Button
          type="button"
          variant="outline"
          onClick={() => onStepChange(currentStep - 1)}
          disabled={isBusy || currentStep === 0}
          className={cn((currentStep === 0 || step?.hideBack) && 'invisible')}
        >
          {backLabel}
        </Button>
        <Button
          type="button"
          onClick={() => (isLast ? onFinish() : onStepChange(currentStep + 1))}
          disabled={isBusy || !canProceed}
        >
          {isBusy ? <Spinner size={16} /> : isLast ? finishLabel : nextLabel}
        </Button>
      </div>
    </div>
  );
}
