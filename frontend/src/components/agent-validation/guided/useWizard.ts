import { useEffect, useMemo, useState } from 'react';
import type { NetworkType } from '@/lib/contexts/AppContext';
import type { ValidationCheck } from '@/lib/agent-validation/checks';
import {
  acknowledgeStep,
  clearWizard,
  createWizardState,
  loadWizard,
  recordResult,
  saveWizard,
  updateAnswers,
  type JobProgress,
  type StepId,
  type WizardAnswers,
  type WizardState,
} from '@/lib/agent-validation/wizard';

/**
 * The wizard's state, restored from the previous visit on this network and saved on every change. The app only
 * renders pages after its client-side health check, so reading storage while initialising is safe here.
 */
export function useWizard(network: NetworkType) {
  const [state, setState] = useState<WizardState>(
    () => loadWizard(network) ?? createWizardState(network),
  );

  useEffect(() => {
    saveWizard(state);
  }, [state]);

  const actions = useMemo(
    () => ({
      setAnswers: (changes: Partial<WizardAnswers>) =>
        setState((current) => updateAnswers(current, changes)),
      record: (step: StepId, checks: ValidationCheck[]) =>
        setState((current) => recordResult(current, step, checks, new Date().toISOString())),
      acknowledge: (step: StepId) => setState((current) => acknowledgeStep(current, step)),
      setJob: (job: JobProgress | null) => setState((current) => ({ ...current, job })),
      goTo: (step: StepId) => setState((current) => ({ ...current, step })),
      restart: () => {
        clearWizard(network);
        setState(createWizardState(network));
      },
    }),
    [network],
  );

  return { state, ...actions };
}

export type WizardApi = ReturnType<typeof useWizard>;
