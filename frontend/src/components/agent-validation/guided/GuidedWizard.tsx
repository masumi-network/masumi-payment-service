import { useEffect, useRef } from 'react';
import { SetupStepActions } from '@/components/setup/wizard/SetupStepParts';
import { SetupStepper } from '@/components/setup/wizard/SetupWizardShell';
import { Button } from '@/components/ui/button';
import { hasFailures } from '@/lib/agent-validation/checks';
import {
  STEP_LABELS,
  advanceBlock,
  nextStep,
  previousStep,
  stepsFor,
  type StepId,
} from '@/lib/agent-validation/wizard';
import { useAppContext } from '@/lib/contexts/AppContext';
import { BuildStep } from './BuildStep';
import { EndpointsStep } from './EndpointsStep';
import { IntentStep } from './IntentStep';
import { LifecycleStep, PurchaseStep } from './JobSteps';
import { NodeStep } from './NodeStep';
import { RegisterStep } from './RegisterStep';
import { ReportStep } from './ReportStep';
import { useWizard, type WizardApi } from './useWizard';

function StepContent({ step, wizard }: { step: StepId; wizard: WizardApi }) {
  switch (step) {
    case 'intent':
      return <IntentStep wizard={wizard} />;
    case 'node':
      return <NodeStep wizard={wizard} />;
    case 'build':
      return <BuildStep wizard={wizard} />;
    case 'endpoints':
      return <EndpointsStep wizard={wizard} />;
    case 'register':
      return <RegisterStep wizard={wizard} />;
    case 'purchase':
      return <PurchaseStep wizard={wizard} />;
    case 'lifecycle':
      return <LifecycleStep wizard={wizard} />;
    case 'report':
      return <ReportStep wizard={wizard} />;
  }
}

/** The guided path: ask what the developer wants, then walk through only the steps that apply. */
export function GuidedWizard() {
  const { network } = useAppContext();
  const wizard = useWizard(network);
  const { state } = wizard;
  const steps = stepsFor(state.answers, state.network);
  // A saved step that no longer belongs to the journey (answers changed) shows the first step instead.
  const step = steps.includes(state.step) ? state.step : steps[0];
  const block = advanceBlock({ ...state, step });
  const result = state.results[step];
  const canContinueAnyway = result != null && hasFailures(result.checks) && !result.acknowledged;
  const following = nextStep({ ...state, step });
  const preceding = previousStep({ ...state, step });
  const isLast = following == null;
  const containerRef = useRef<HTMLDivElement>(null);
  const hasMountedRef = useRef(false);

  // After a step change, bring the new step into view and move focus to its title, so keyboard and
  // screen-reader users land at the top of the new step instead of on a button that no longer exists.
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    const container = containerRef.current;
    container?.scrollIntoView({ block: 'start' });
    const title = container?.querySelector<HTMLElement>('[data-step-title]');
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, [step]);

  return (
    <div ref={containerRef} className="mx-auto w-full max-w-3xl scroll-mt-4">
      <SetupStepper
        labels={steps.map((id) => STEP_LABELS[id])}
        currentStep={steps.indexOf(step) + 1}
      />
      <div key={step} className="pt-6 animate-fade-in-up">
        <StepContent step={step} wizard={wizard} />
      </div>
      {isLast ? (
        <div className="pt-6">
          {preceding && (
            <Button type="button" variant="ghost" onClick={() => wizard.goTo(preceding)}>
              Back
            </Button>
          )}
        </div>
      ) : (
        <SetupStepActions
          onBack={preceding ? () => wizard.goTo(preceding) : undefined}
          primaryLabel="Continue"
          onPrimary={() => wizard.goTo(following)}
          isPrimaryDisabled={block.blocked}
          blockedReason={block.reason}
          secondary={
            canContinueAnyway ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  wizard.acknowledge(step);
                  wizard.goTo(following);
                }}
              >
                Continue anyway
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
