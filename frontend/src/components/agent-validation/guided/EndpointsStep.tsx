import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { registryReadsVia } from '@/lib/agent-validation/agent-type';
import { check, type ValidationCheck } from '@/lib/agent-validation/checks';
import { findAgentsSharingBaseUrl, sharedBaseUrlCheck } from '@/lib/agent-validation/registration';
import { runEndpointSuite } from '@/lib/agent-validation/suite';
import { useAgentValidationApi } from '@/lib/hooks/useAgentValidationApi';
import { useAllAgents } from '@/lib/queries/useAgents';
import { CheckList } from '../CheckList';
import { StepFrame } from './StepFrame';
import type { WizardApi } from './useWizard';

/** Calls the agent's endpoints the way the registry and buyers do, and explains what is wrong. */
export function EndpointsStep({ wizard }: { wizard: WizardApi }) {
  const api = useAgentValidationApi();
  const { agents } = useAllAgents();
  const [isRunning, setIsRunning] = useState(false);
  const { answers, results } = wizard.state;
  const result = results.endpoints;
  const isRegistered = answers.goal === 'registered';
  const readsVia = registryReadsVia(answers.agentType);
  const skipsSuite = readsVia != null;
  const url = answers.apiBaseUrl.trim();

  async function run() {
    setIsRunning(true);
    let checks: ValidationCheck[];
    if (skipsSuite) {
      checks = [
        check('skipped', 'endpoints.spec_url', `The registry reads your ${readsVia}`, {
          detail: `${answers.agentType} agents are checked by the registry through their ${readsVia}, not through MIP-003 endpoints.`,
          fix: `Make sure the ${readsVia} you register is public, returns the document and is valid.`,
        }),
      ];
    } else {
      const suite = await runEndpointSuite(api.probe, {
        apiBaseUrl: url,
        expectedAgentIdentifier: answers.agentIdentifier ?? undefined,
      });
      checks = [
        ...suite.checks,
        ...(isRegistered ? [] : [sharedBaseUrlCheck(findAgentsSharingBaseUrl(agents, url, null))]),
      ];
    }
    wizard.record('endpoints', checks);
    setIsRunning(false);
  }

  return (
    <StepFrame
      title="Check your agent's endpoints"
      description="The node calls your agent the way the registry and buyers do. Problems here are why an agent shows as Offline or Invalid, or fails for a buyer."
    >
      {skipsSuite ? (
        <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          {answers.agentType} agents are not checked through /availability. Continue to
          registration, and make sure the {readsVia} you register is public and valid.
        </p>
      ) : (
        <FormField
          label="Agent base URL"
          htmlFor="endpoints-url"
          required
          hint={
            isRegistered
              ? 'Taken from the registered agent.'
              : 'The public URL you will register, without a trailing path such as /availability.'
          }
        >
          <Input
            id="endpoints-url"
            value={answers.apiBaseUrl}
            onChange={(event) => wizard.setAnswers({ apiBaseUrl: event.target.value })}
            readOnly={isRegistered}
            placeholder="https://my-agent.example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      )}
      <Button type="button" onClick={run} disabled={isRunning || (!skipsSuite && url.length === 0)}>
        {isRunning ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
        {result ? 'Run the checks again' : 'Check the endpoints'}
      </Button>
      {result && <CheckList checks={result.checks} />}
    </StepFrame>
  );
}
