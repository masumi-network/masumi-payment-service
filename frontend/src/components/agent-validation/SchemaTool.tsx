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
import { Tabs } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { check, type ValidationCheck } from '@/lib/agent-validation/checks';
import { COWORKER_METADATA_EXAMPLE, INPUT_SCHEMA_EXAMPLE } from '@/lib/agent-validation/examples';
import { useAgentValidationApi, type ValidateBody } from '@/lib/hooks/useAgentValidationApi';
import { InputSchemaValidator } from '@/components/developers/InputSchemaValidator';
import { CheckList } from './CheckList';

type Kind = ValidateBody['kind'];

const KINDS: { value: Kind; label: string; example: string; hint: string }[] = [
  {
    value: 'input_schema',
    label: 'Agent input schema (MIP-003)',
    example: INPUT_SCHEMA_EXAMPLE,
    hint: 'What your /input_schema endpoint returns, or the input_schema in a /status answer.',
  },
  {
    value: 'coworker_metadata',
    label: 'Sokosumi coworker metadata',
    example: COWORKER_METADATA_EXAMPLE,
    hint: 'The metadata JSON of a coworker. A single invalid coworker breaks the marketplace list, so check it before pasting it in.',
  },
];

const TABS = [{ name: 'Check JSON' }, { name: 'Visual builder' }];

/** Checks pasted JSON with the same rules the node applies to live responses, and hosts the visual schema builder. */
export function SchemaTool() {
  const api = useAgentValidationApi();
  const [tab, setTab] = useState(TABS[0].name);
  const [kind, setKind] = useState<Kind>('input_schema');
  const [text, setText] = useState(INPUT_SCHEMA_EXAMPLE);
  const [checks, setChecks] = useState<ValidationCheck[] | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const selected = KINDS.find((entry) => entry.value === kind) ?? KINDS[0];

  function changeKind(next: Kind) {
    const nextKind = KINDS.find((entry) => entry.value === next) ?? KINDS[0];
    // Only swap the text when it is still the untouched example of the previous kind.
    if (text === selected.example || text.trim().length === 0) setText(nextKind.example);
    setKind(next);
    setChecks(null);
  }

  async function run() {
    setIsRunning(true);
    const outcome = await api.validate({ kind, json: text });
    setChecks(
      outcome.ok
        ? outcome.data.Checks
        : [
            check('fail', 'schema.validate_failed', 'The JSON could be checked', {
              detail: outcome.message,
            }),
          ],
    );
    setIsRunning(false);
  }

  return (
    <div className="space-y-6">
      <Tabs tabs={TABS} activeTab={tab} onTabChange={setTab} />
      {tab === 'Check JSON' ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="What are you checking?" htmlFor="schema-kind" className="min-w-64">
              <Select value={kind} onValueChange={(value) => changeKind(value as Kind)}>
                <SelectTrigger id="schema-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <Button type="button" onClick={run} disabled={isRunning || text.trim().length === 0}>
              {isRunning ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
              Check
            </Button>
            <Button type="button" variant="outline" onClick={() => setText(selected.example)}>
              Load example
            </Button>
          </div>
          <FormField label="JSON" htmlFor="schema-json" hint={selected.hint}>
            <Textarea
              id="schema-json"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="min-h-72 font-mono text-xs"
              spellCheck={false}
            />
          </FormField>
          {checks && <CheckList checks={checks} />}
        </div>
      ) : (
        <InputSchemaValidator />
      )}
    </div>
  );
}
