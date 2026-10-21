import { useState } from 'react';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAppContext } from '@/lib/contexts/AppContext';
import type { JobProgress } from '@/lib/agent-validation/wizard';
import { JobLifecyclePanel } from './JobLifecyclePanel';
import { JobStartPanel } from './JobStartPanel';

/** Start a job on any agent, pay for it, and follow it to its result, without going through the wizard. */
export function JobRunnerTool() {
  const { network } = useAppContext();
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [agentIdentifier, setAgentIdentifier] = useState('');
  const [isFreeAgent, setIsFreeAgent] = useState(false);
  const [job, setJob] = useState<JobProgress | null>(null);

  const target = {
    apiBaseUrl: apiBaseUrl.trim(),
    agentIdentifier: agentIdentifier.trim() || null,
    isFreeAgent,
  };
  const hasUrl = target.apiBaseUrl.length > 0;

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        Runs a whole job the way a buyer would. A paid job locks test funds, so it only runs on
        Preprod (you are on {network}).
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="Agent base URL" htmlFor="runner-url" required>
          <Input
            id="runner-url"
            value={apiBaseUrl}
            onChange={(event) => {
              setApiBaseUrl(event.target.value);
              setJob(null);
            }}
            placeholder="https://my-agent.example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        <FormField
          label="Registered agent identifier"
          htmlFor="runner-agent"
          hint="Optional. Compared with what the agent returns."
        >
          <Input
            id="runner-agent"
            value={agentIdentifier}
            onChange={(event) => setAgentIdentifier(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={isFreeAgent}
          onCheckedChange={setIsFreeAgent}
          aria-label="This agent is free"
        />
        This agent is free
      </label>
      {hasUrl ? (
        <>
          <JobStartPanel
            target={target}
            job={job}
            onJobChange={setJob}
            onChecks={() => undefined}
          />
          {job?.jobId != null && (
            <section className="space-y-4 border-t pt-8" aria-labelledby="runner-lifecycle-heading">
              <h2 id="runner-lifecycle-heading" className="text-base font-semibold">
                3. Follow the job
              </h2>
              <JobLifecyclePanel key={job.jobId} target={target} job={job} />
            </section>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Enter the agent&apos;s base URL to start.</p>
      )}
    </div>
  );
}
