import { JobLifecyclePanel } from '../JobLifecyclePanel';
import { JobStartPanel, type JobTarget } from '../JobStartPanel';
import { StepFrame } from './StepFrame';
import type { WizardApi } from './useWizard';

function targetOf(wizard: WizardApi): JobTarget {
  const { answers } = wizard.state;
  return {
    apiBaseUrl: answers.apiBaseUrl.trim(),
    agentIdentifier: answers.agentIdentifier,
    isFreeAgent: answers.isFreeAgent,
  };
}

/** Start a job on the agent and, for a paid agent, pay for it with a mock purchase. */
export function PurchaseStep({ wizard }: { wizard: WizardApi }) {
  const free = wizard.state.answers.isFreeAgent;
  return (
    <StepFrame
      title={free ? 'Start a test job' : 'Start a job and pay for it'}
      description={
        free
          ? 'Starts a job on your agent the way a buyer would and checks everything it answers.'
          : 'Starts a job on your agent, finds the payment it created on this node, and locks test funds the way a buyer would.'
      }
    >
      <JobStartPanel
        target={targetOf(wizard)}
        job={wizard.state.job}
        onJobChange={wizard.setJob}
        onChecks={(checks) => wizard.record('purchase', checks)}
      />
    </StepFrame>
  );
}

/** Follow the job to its result, answer human-in-the-loop requests and verify the result hash. */
export function LifecycleStep({ wizard }: { wizard: WizardApi }) {
  const { job } = wizard.state;
  return (
    <StepFrame
      title="Follow the job to its result"
      description="Watches the job until the agent finishes, answers it if it asks for input, and checks that the result hash on-chain matches the result it returned."
    >
      {job?.jobId == null ? (
        <p className="text-sm text-muted-foreground">Start a job in the previous step first.</p>
      ) : (
        <JobLifecyclePanel
          target={targetOf(wizard)}
          job={job}
          onFinished={(checks) => wizard.record('lifecycle', checks)}
        />
      )}
    </StepFrame>
  );
}
