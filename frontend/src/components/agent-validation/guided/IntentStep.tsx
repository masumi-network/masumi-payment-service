import { Bot, Check, FlaskConical, Rocket, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { FormField } from '@/components/ui/form-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useAllAgents } from '@/lib/queries/useAgents';
import type { AgentType, Goal, Subject } from '@/lib/agent-validation/wizard';
import { cn } from '@/lib/utils';
import { StepFrame } from './StepFrame';
import type { WizardApi } from './useWizard';

function Choice({
  selected,
  icon,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex flex-1 gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-primary bg-primary/5' : 'hover:border-foreground/30',
      )}
    >
      <span className="mt-0.5 text-muted-foreground" aria-hidden>
        {icon}
      </span>
      <span className="flex-1 space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      {selected && <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-label="Selected" />}
    </button>
  );
}

const AGENT_TYPES: { value: AgentType; label: string; hint: string }[] = [
  {
    value: 'Standard',
    label: 'Standard (MIP-003 API)',
    hint: 'Your agent implements /availability, /start_job and the other MIP-003 endpoints.',
  },
  {
    value: 'A2A',
    label: 'A2A (agent card)',
    hint: 'The registry checks your MIP-002 agent card. MIP-003 endpoints are optional extras.',
  },
  {
    value: 'OpenApi',
    label: 'OpenAPI',
    hint: 'The registry checks your OpenAPI specification URL, not /availability.',
  },
  {
    value: 'X402',
    label: 'x402',
    hint: 'The registry checks your x402 resources manifest, not /availability.',
  },
];

/** Step 0: ask what the developer wants to do, so only the relevant checks run. */
export function IntentStep({ wizard }: { wizard: WizardApi }) {
  const { network } = useAppContext();
  const { agents } = useAllAgents();
  const { answers } = wizard.state;
  const registeredAgents = agents.filter(
    (agent) => agent.state === 'RegistrationConfirmed' || agent.state === 'UpdateConfirmed',
  );
  const selectedType =
    AGENT_TYPES.find((entry) => entry.value === answers.agentType) ?? AGENT_TYPES[0];

  return (
    <StepFrame
      title="What do you want to do?"
      description="Your answers decide which steps you see. You can start over at any time."
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What are you validating?</legend>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Choice
            selected={answers.subject === 'agent'}
            icon={<Bot className="size-5" />}
            title="A Masumi agent"
            description="An agent that sells its work through this node."
            onSelect={() => wizard.setAnswers({ subject: 'agent' })}
          />
          <Choice
            selected={answers.subject === 'coworker'}
            icon={<Users className="size-5" />}
            title="A Sokosumi coworker"
            description="Check the coworker metadata the marketplace reads."
            onSelect={() => wizard.setAnswers({ subject: 'coworker' })}
          />
        </div>
      </fieldset>

      {answers.subject === 'agent' && (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Where are you?</legend>
            <div className="flex flex-col gap-3 lg:flex-row">
              <Choice
                selected={answers.goal === 'new'}
                icon={<Rocket className="size-5" />}
                title="Release a new agent"
                description="Node, endpoints, registration and a test job, step by step."
                onSelect={() =>
                  wizard.setAnswers({ goal: 'new', agentIdentifier: null, registryRequestId: null })
                }
              />
              <Choice
                selected={answers.goal === 'registered'}
                icon={<Bot className="size-5" />}
                title="Test a registered agent"
                description="Endpoints and a full test job for an agent already on this node."
                onSelect={() => wizard.setAnswers({ goal: 'registered' })}
              />
              <Choice
                selected={answers.goal === 'endpoints'}
                icon={<FlaskConical className="size-5" />}
                title="Just check my endpoints"
                description="No registration and no purchase."
                onSelect={() =>
                  wizard.setAnswers({
                    goal: 'endpoints',
                    agentIdentifier: null,
                    registryRequestId: null,
                  })
                }
              />
            </div>
          </fieldset>

          {answers.goal === 'registered' ? (
            <FormField label="Registered agent" htmlFor="intent-agent" required>
              <Select
                value={
                  registeredAgents.find(
                    (agent) => agent.agentIdentifier === answers.agentIdentifier,
                  )?.id ?? ''
                }
                onValueChange={(id) => {
                  const agent = registeredAgents.find((entry) => entry.id === id);
                  if (agent == null) return;
                  wizard.setAnswers({
                    agentIdentifier: agent.agentIdentifier,
                    apiBaseUrl: agent.apiBaseUrl ?? '',
                    agentType: agent.type,
                  });
                }}
                disabled={registeredAgents.length === 0}
              >
                <SelectTrigger id="intent-agent">
                  <SelectValue
                    placeholder={
                      registeredAgents.length === 0
                        ? `No registered agents on ${network}`
                        : 'Select an agent'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {registeredAgents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name} · {agent.type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          ) : (
            <FormField label="Agent type" htmlFor="intent-type" hint={selectedType.hint}>
              <Select
                value={answers.agentType}
                onValueChange={(value) => wizard.setAnswers({ agentType: value as AgentType })}
              >
                <SelectTrigger id="intent-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGENT_TYPES.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}

          {answers.goal !== 'endpoints' && (
            <label className="flex items-start gap-3 text-sm">
              <Switch
                checked={answers.isFreeAgent}
                onCheckedChange={(checked) => wizard.setAnswers({ isFreeAgent: checked })}
                aria-label="This agent is free"
              />
              <span>
                This agent is free
                <span className="block text-xs text-muted-foreground">
                  A free agent needs no payment, so the test job skips the purchase
                  {network === 'Mainnet' ? ' (and is the only test job available on Mainnet)' : ''}.
                </span>
              </span>
            </label>
          )}
        </>
      )}
      {network === 'Mainnet' &&
        answers.subject === 'agent' &&
        !answers.isFreeAgent &&
        answers.goal !== 'endpoints' && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
            You are on Mainnet. A test purchase would spend real funds, so the test job is only
            offered on Preprod. Switch the network to Preprod to run the whole flow.
          </p>
        )}
    </StepFrame>
  );
}
