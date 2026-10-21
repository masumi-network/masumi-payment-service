import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getRegistryAgentIdentifier } from '@/lib/api/generated';
import { settle } from '@/lib/agent-validation/api-outcome';
import { checkRegistryStatus } from '@/lib/agent-validation/registry-status';
import { check, type ValidationCheck } from '@/lib/agent-validation/checks';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useAgentValidationApi } from '@/lib/hooks/useAgentValidationApi';
import { useAllAgents } from '@/lib/queries/useAgents';
import { CheckList } from './CheckList';

/** Why is a registered agent (not) showing up? Checks its registration, its on-chain metadata and its live endpoint. */
export function RegistryStatusTool({ initialAgentId = '' }: { initialAgentId?: string }) {
  const { apiClient, network } = useAppContext();
  const api = useAgentValidationApi();
  const { agents, isLoading } = useAllAgents();
  const [agentId, setAgentId] = useState(initialAgentId);
  const [checks, setChecks] = useState<ValidationCheck[] | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const agent = agents.find((entry) => entry.id === agentId);

  async function run() {
    if (agent == null) return;
    setIsRunning(true);
    try {
      setChecks(
        await checkRegistryStatus(agent, agents, {
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
        }),
      );
    } catch (error) {
      setChecks([
        check('fail', 'registry.tool_failed', 'The check could run', {
          detail: error instanceof Error ? error.message : 'Unexpected error',
        }),
      ]);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Pick an agent registered on this node. The check follows what the registry does: it reads
        the registration, the metadata on the chain, and calls your agent&apos;s /availability.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Registered agent" htmlFor="registry-agent" className="min-w-72 flex-1">
          <Select
            value={agentId}
            onValueChange={(value) => {
              setAgentId(value);
              setChecks(null);
            }}
            disabled={isLoading || agents.length === 0}
          >
            <SelectTrigger id="registry-agent">
              <SelectValue
                placeholder={
                  isLoading
                    ? 'Loading agents…'
                    : agents.length === 0
                      ? 'No agents registered on this network'
                      : 'Select an agent'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {agents.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name} · {entry.state}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <Button type="button" onClick={run} disabled={agent == null || isRunning}>
          {isRunning ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
          Check registry status
        </Button>
      </div>
      {checks && <CheckList checks={checks} />}
    </div>
  );
}
