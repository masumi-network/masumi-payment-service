import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Play } from 'lucide-react';
import { RegisterAIAgentDialog } from '@/components/ai-agents/RegisterAIAgentDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { getRegistryAgentIdentifier } from '@/lib/api/generated';
import { settle } from '@/lib/agent-validation/api-outcome';
import { hasFailures } from '@/lib/agent-validation/checks';
import {
  registrationFailureCheck,
  registrationProgress,
} from '@/lib/agent-validation/registration';
import { checkRegistryStatus } from '@/lib/agent-validation/registry-status';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useAgentValidationApi } from '@/lib/hooks/useAgentValidationApi';
import { useAllAgents } from '@/lib/queries/useAgents';
import { MASUMI_REGISTER_AGENT_URL } from '@/lib/masumi-links';
import { CheckList } from '../CheckList';
import { StepFrame } from './StepFrame';
import type { WizardApi } from './useWizard';

const REGISTRATION_POLL_MS = 6_000;

const TONE_BADGE = { pending: 'processing', success: 'success', failed: 'destructive' } as const;

/**
 * Registers the agent with the existing register dialog, then follows the registration until it is
 * confirmed (or explains why it failed) and finally checks how the registry sees the agent.
 */
export function RegisterStep({ wizard }: { wizard: WizardApi }) {
  const { apiClient, network } = useAppContext();
  const api = useAgentValidationApi();
  const { agents, refetch } = useAllAgents();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const { answers, results } = wizard.state;
  const requestId = answers.registryRequestId;
  const endpointFailures = (results.endpoints?.checks ?? []).filter(
    (entry) => entry.status === 'fail',
  );

  const entryQuery = useQuery({
    queryKey: ['agent-validation', 'registration', requestId],
    queryFn: async () => {
      const fresh = await refetch();
      return fresh.data?.find((agent) => agent.id === requestId) ?? null;
    },
    enabled: requestId != null,
    refetchInterval: (query) => {
      const entry = query.state.data;
      return entry != null && registrationProgress(entry.state).isDone
        ? false
        : REGISTRATION_POLL_MS;
    },
  });
  const entry = entryQuery.data ?? null;
  const progress = entry ? registrationProgress(entry.state) : null;
  const result = results.register;

  async function checkRegistry() {
    if (entry == null) return;
    setIsChecking(true);
    try {
      const checks = await checkRegistryStatus(entry, agents, {
        probe: api.probe,
        fetchMetadata: (agentIdentifier) =>
          settle(
            () =>
              getRegistryAgentIdentifier({
                client: apiClient,
                query: { network, agentIdentifier },
              }),
            'The agent metadata could not be read from the chain',
          ),
      });
      wizard.setAnswers({ agentIdentifier: entry.agentIdentifier });
      wizard.record('register', checks);
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <StepFrame
      title="Register your agent"
      description="Registering mints your agent's entry on-chain, which costs ADA. The registry then checks your endpoint every couple of minutes."
    >
      {requestId == null && (
        <div className="space-y-4">
          {endpointFailures.length > 0 && (
            <div
              role="alert"
              className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium">The registry will not list this agent yet</p>
                <p>
                  These endpoint checks failed:{' '}
                  {endpointFailures.map((entryCheck) => entryCheck.label).join('; ')}. You can
                  register anyway and fix the agent afterwards, but you pay for the registration
                  either way.
                </p>
              </div>
            </div>
          )}
          {answers.apiBaseUrl && (
            <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
              Use this base URL in the form:
              <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">
                {answers.apiBaseUrl.trim()}
              </code>
              <CopyButton value={answers.apiBaseUrl.trim()} />
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Fill in the Author name under Additional fields: the registry cannot read an agent that
            has none.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => setDialogOpen(true)}>
              Open the register form
            </Button>
            <a
              href={MASUMI_REGISTER_AGENT_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-primary underline-offset-2 hover:underline"
            >
              Registration guide
            </a>
          </div>
        </div>
      )}

      {requestId != null && entry == null && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Looking for your registration…
        </p>
      )}

      {entry != null && progress != null && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2" role="status">
            <Badge variant={TONE_BADGE[progress.tone]}>{progress.label}</Badge>
            <span className="text-sm">{entry.name}</span>
            {progress.tone === 'pending' && (
              <span className="text-xs text-muted-foreground">
                Confirming on-chain; this can take several minutes. This page checks every{' '}
                {REGISTRATION_POLL_MS / 1000} s.
              </span>
            )}
          </div>
          {progress.tone === 'failed' && (
            <>
              <CheckList checks={[registrationFailureCheck(entry.error)]} />
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  wizard.setAnswers({ registryRequestId: null, agentIdentifier: null })
                }
              >
                Register again
              </Button>
            </>
          )}
          {progress.tone === 'success' && (
            <>
              <Button type="button" onClick={checkRegistry} disabled={isChecking}>
                {isChecking ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Play aria-hidden />
                )}
                {result ? 'Check how the registry sees it again' : 'Check how the registry sees it'}
              </Button>
              {result && (
                <>
                  <CheckList checks={result.checks} />
                  {hasFailures(result.checks) && (
                    <p className="text-xs text-muted-foreground">
                      The registry re-checks your endpoint every couple of minutes, so after a fix
                      it can take a short while to show Online.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      <RegisterAIAgentDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSuccess={(registryRequestId) => {
          if (registryRequestId) wizard.setAnswers({ registryRequestId, agentIdentifier: null });
        }}
      />
    </StepFrame>
  );
}
