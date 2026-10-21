import { useState } from 'react';
import { ExternalLink, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { check } from '@/lib/agent-validation/checks';
import { COWORKER_METADATA_EXAMPLE } from '@/lib/agent-validation/examples';
import { useAgentValidationApi } from '@/lib/hooks/useAgentValidationApi';
import {
  MASUMI_AGENTIC_SERVICE_API_URL,
  MASUMI_AGENT_QUICKSTART_URL,
  MASUMI_COWORKER_METADATA_URL,
  MASUMI_HUMAN_IN_THE_LOOP_URL,
  MASUMI_REGISTRY_METADATA_URL,
} from '@/lib/masumi-links';
import { CheckList } from '../CheckList';
import { SchemaTool } from '../SchemaTool';
import { StepFrame } from './StepFrame';
import type { WizardApi } from './useWizard';

const GUIDES = [
  {
    href: MASUMI_AGENT_QUICKSTART_URL,
    title: 'Build an agent',
    text: 'The quickstart with the Masumi Python SDK.',
  },
  {
    href: MASUMI_AGENTIC_SERVICE_API_URL,
    title: 'Agentic Service API (MIP-003)',
    text: 'The endpoints your agent must implement.',
  },
  {
    href: MASUMI_HUMAN_IN_THE_LOOP_URL,
    title: 'Human in the loop',
    text: 'Asking the buyer for more input mid-job.',
  },
  {
    href: MASUMI_REGISTRY_METADATA_URL,
    title: 'Registry metadata',
    text: 'What the registry stores about your agent.',
  },
];

function AgentBuild() {
  return (
    <StepFrame
      title="Build your agent"
      description="Read the guides, then describe the input your agent needs. The schema you build here is what your /input_schema endpoint returns."
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {GUIDES.map((guide) => (
          <li key={guide.href}>
            <a
              href={guide.href}
              target="_blank"
              rel="noreferrer"
              className="group block h-full rounded-lg border p-4 transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {guide.title}
                <ExternalLink className="size-3 text-muted-foreground" aria-hidden />
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{guide.text}</span>
            </a>
          </li>
        ))}
      </ul>
      <SchemaTool />
    </StepFrame>
  );
}

function CoworkerBuild({ wizard }: { wizard: WizardApi }) {
  const api = useAgentValidationApi();
  const [text, setText] = useState(COWORKER_METADATA_EXAMPLE);
  const [isRunning, setIsRunning] = useState(false);
  const result = wizard.state.results.build;

  async function run() {
    setIsRunning(true);
    const outcome = await api.validate({ kind: 'coworker_metadata', json: text });
    wizard.record(
      'build',
      outcome.ok
        ? outcome.data.Checks
        : [
            check('fail', 'coworker.validate_failed', 'The metadata could be checked', {
              detail: outcome.message,
            }),
          ],
    );
    setIsRunning(false);
  }

  return (
    <StepFrame
      title="Check your coworker metadata"
      description={
        <>
          Paste the metadata JSON of your coworker. One invalid coworker makes the
          marketplace&apos;s whole list fail to load, so it is worth checking first.{' '}
          <a
            href={MASUMI_COWORKER_METADATA_URL}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            Metadata guide
          </a>
        </>
      }
    >
      <FormField label="Coworker metadata (JSON)" htmlFor="coworker-json">
        <Textarea
          id="coworker-json"
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="min-h-72 font-mono text-xs"
          spellCheck={false}
        />
      </FormField>
      <Button type="button" onClick={run} disabled={isRunning || text.trim().length === 0}>
        {isRunning ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
        Check metadata
      </Button>
      {result && <CheckList checks={result.checks} />}
    </StepFrame>
  );
}

export function BuildStep({ wizard }: { wizard: WizardApi }) {
  return wizard.state.answers.subject === 'coworker' ? (
    <CoworkerBuild wizard={wizard} />
  ) : (
    <AgentBuild />
  );
}
