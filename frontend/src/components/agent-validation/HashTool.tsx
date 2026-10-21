import { useState } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { parseInputJson } from '@/lib/agent-validation/input-json';
import { newIdentifierFromPurchaser } from '@/lib/agent-validation/purchase';
import {
  useAgentValidationApi,
  type HashBody,
  type HashResult,
} from '@/lib/hooks/useAgentValidationApi';
import { INPUT_SCHEMA_EXAMPLE } from '@/lib/agent-validation/examples';

type Kind = HashBody['kind'];

const KINDS: { value: Kind; label: string; hint: string }[] = [
  {
    value: 'input',
    label: 'Input hash (MIP-004)',
    hint: 'sha256 of identifier_from_purchaser + ";" + the canonical JSON of input_data. Your agent returns it from /start_job.',
  },
  {
    value: 'result',
    label: 'Result hash (MIP-004)',
    hint: 'sha256 of identifier_from_purchaser + ";" + the JSON-escaped result. Your agent submits it on-chain.',
  },
  {
    value: 'input_schema',
    label: 'Input schema hash (MIP-003)',
    hint: 'sha256 of the canonical JSON of the input_schema from /status. A buyer sends it as input_schema_hash in /provide_input.',
  },
];

/**
 * Computes the hashes agents and buyers exchange, with the exact text that was hashed. When an agent's hash
 * does not match, comparing that text character by character is the quickest way to find out why.
 */
export function HashTool() {
  const api = useAgentValidationApi();
  const [kind, setKind] = useState<Kind>('input');
  const [identifier, setIdentifier] = useState(() => newIdentifierFromPurchaser());
  const [inputText, setInputText] = useState('{\n  "topic": "cats"\n}');
  const [resultText, setResultText] = useState('Line one\n"quoted" text');
  const [schemaText, setSchemaText] = useState(INPUT_SCHEMA_EXAMPLE);
  const [agentHash, setAgentHash] = useState('');
  const [computed, setComputed] = useState<HashResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const selected = KINDS.find((entry) => entry.value === kind) ?? KINDS[0];
  const comparison =
    computed == null || agentHash.trim().length === 0
      ? null
      : agentHash.trim().toLowerCase() === computed.hash;

  async function compute() {
    setError(null);
    setComputed(null);
    let body: HashBody;
    if (kind === 'input') {
      const input = parseInputJson(inputText);
      if (!input.ok) {
        setError(input.message);
        return;
      }
      body = { kind, identifierFromPurchaser: identifier.trim(), inputData: input.data };
    } else if (kind === 'result') {
      body = { kind, identifierFromPurchaser: identifier.trim(), result: resultText };
    } else {
      body = { kind, json: schemaText };
    }
    setIsRunning(true);
    const outcome = await api.hash(body);
    if (outcome.ok) setComputed(outcome.data);
    else setError(outcome.message);
    setIsRunning(false);
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Hashes are computed on the node with the same canonical JSON (RFC 8785) the Sokosumi
        marketplace uses to verify them, so a match here means a match for a real buyer.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="Hash" htmlFor="hash-kind" hint={selected.hint}>
          <Select
            value={kind}
            onValueChange={(value) => {
              setKind(value as Kind);
              setComputed(null);
              setError(null);
            }}
          >
            <SelectTrigger id="hash-kind">
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
        {kind !== 'input_schema' && (
          <FormField label="identifier_from_purchaser" htmlFor="hash-identifier">
            <div className="flex gap-2">
              <Input
                id="hash-identifier"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setIdentifier(newIdentifierFromPurchaser())}
              >
                New
              </Button>
            </div>
          </FormField>
        )}
      </div>

      {kind === 'input' && (
        <FormField
          label="input_data (JSON)"
          htmlFor="hash-input"
          hint="Flat object: one value per input field id."
        >
          <Textarea
            id="hash-input"
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            className="min-h-32 font-mono text-xs"
            spellCheck={false}
          />
        </FormField>
      )}
      {kind === 'result' && (
        <FormField
          label="Result text"
          htmlFor="hash-result"
          hint="Exactly what your agent returns as result from /status."
        >
          <Textarea
            id="hash-result"
            value={resultText}
            onChange={(event) => setResultText(event.target.value)}
            className="min-h-32 font-mono text-xs"
            spellCheck={false}
          />
        </FormField>
      )}
      {kind === 'input_schema' && (
        <FormField label="input_schema (JSON)" htmlFor="hash-schema">
          <Textarea
            id="hash-schema"
            value={schemaText}
            onChange={(event) => setSchemaText(event.target.value)}
            className="min-h-48 font-mono text-xs"
            spellCheck={false}
          />
        </FormField>
      )}

      <Button type="button" onClick={compute} disabled={isRunning}>
        {isRunning && <Loader2 className="animate-spin" aria-hidden />}
        Compute hash
      </Button>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {computed && (
        <div className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Hash</p>
            <div className="flex items-center gap-1 rounded-md bg-muted px-3 py-2">
              <code className="min-w-0 flex-1 break-all text-xs">{computed.hash}</code>
              <CopyButton value={computed.hash} />
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Text that was hashed</p>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
              {computed.preimage}
            </pre>
          </div>
          <FormField
            label="Hash from your agent"
            htmlFor="hash-compare"
            hint="Paste the hash your agent produced to compare."
          >
            <Input
              id="hash-compare"
              value={agentHash}
              onChange={(event) => setAgentHash(event.target.value)}
              className="font-mono"
              spellCheck={false}
            />
          </FormField>
          {comparison != null && (
            <p
              role="status"
              className={
                comparison
                  ? 'flex items-center gap-2 text-sm text-green-600 dark:text-green-400'
                  : 'flex items-center gap-2 text-sm text-destructive'
              }
            >
              {comparison ? (
                <CheckCircle2 className="size-4" aria-hidden />
              ) : (
                <XCircle className="size-4" aria-hidden />
              )}
              {comparison
                ? 'The hashes are identical.'
                : 'The hashes differ. Compare the text your agent hashes with the text above, character by character.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
