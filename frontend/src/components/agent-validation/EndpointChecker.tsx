import { useState } from 'react';
import { Loader2, Play, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { check, type ValidationCheck } from '@/lib/agent-validation/checks';
import {
  ENDPOINT_OPTIONS,
  endpointOption,
  missingInputs,
  type ProbeEndpointName,
} from '@/lib/agent-validation/endpoints';
import { parseInputJson } from '@/lib/agent-validation/input-json';
import { newIdentifierFromPurchaser } from '@/lib/agent-validation/purchase';
import { runEndpointSuite } from '@/lib/agent-validation/suite';
import { useAgentValidationApi, type ProbeResult } from '@/lib/hooks/useAgentValidationApi';
import { CheckList } from './CheckList';
import { ResponseDetails } from './ResponseDetails';

type RunResult = { checks: ValidationCheck[]; response: ProbeResult | null };

/** Calls the endpoints of an agent from the node and explains what the registry and buyers will make of them. */
export function EndpointChecker({ initialUrl = '' }: { initialUrl?: string }) {
  const api = useAgentValidationApi();
  const [apiBaseUrl, setApiBaseUrl] = useState(initialUrl);
  const [agentIdentifier, setAgentIdentifier] = useState('');
  const [endpoint, setEndpoint] = useState<ProbeEndpointName>('availability');
  const [jobId, setJobId] = useState('');
  const [identifier, setIdentifier] = useState(() => newIdentifierFromPurchaser());
  const [inputText, setInputText] = useState('{}');
  const [schemaHash, setSchemaHash] = useState('');
  const [isFreeAgent, setIsFreeAgent] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  const option = endpointOption(endpoint);
  const trimmedUrl = apiBaseUrl.trim();
  const expected = agentIdentifier.trim() || undefined;

  async function runSuite() {
    setIsRunning(true);
    const outcome = await runEndpointSuite(api.probe, {
      apiBaseUrl: trimmedUrl,
      expectedAgentIdentifier: expected,
    });
    setResult({ checks: outcome.checks, response: null });
    setIsRunning(false);
  }

  async function runOne() {
    const missing = missingInputs(endpoint, { jobId, identifierFromPurchaser: identifier });
    const input = parseInputJson(inputText);
    if (missing.length > 0 || !input.ok) {
      setResult({
        checks: [
          check('fail', 'checker.input', 'The request can be sent', {
            detail: !input.ok ? input.message : `Fill in: ${missing.join(', ')}.`,
            fix: 'Complete the fields above and run the check again.',
          }),
        ],
        response: null,
      });
      return;
    }
    setIsRunning(true);
    const outcome = await api.probe({
      apiBaseUrl: trimmedUrl,
      endpoint,
      ...(expected ? { expectedAgentIdentifier: expected } : {}),
      ...(option.needs.includes('jobId') ? { jobId: jobId.trim() } : {}),
      ...(option.needs.includes('identifierFromPurchaser')
        ? { identifierFromPurchaser: identifier.trim(), inputData: input.data }
        : {}),
      ...(endpoint === 'provide_input' && schemaHash.trim()
        ? { inputSchemaHash: schemaHash.trim() }
        : {}),
      ...(endpoint === 'start_job' ? { isFreeAgent } : {}),
    });
    setResult(
      outcome.ok
        ? { checks: outcome.data.Checks, response: outcome.data }
        : {
            checks: [
              check('fail', 'checker.probe_failed', 'The check could run', {
                detail: outcome.message,
              }),
            ],
            response: null,
          },
    );
    setIsRunning(false);
  }

  const canRun = trimmedUrl.length > 0 && !isRunning;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        The node calls your agent the way the registry and buyers do, so you see what they see.
        Private and local addresses are never contacted, and redirects are reported, not followed.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          label="Agent base URL"
          htmlFor="checker-url"
          required
          hint="As registered, without a trailing path such as /availability."
        >
          <Input
            id="checker-url"
            value={apiBaseUrl}
            onChange={(event) => setApiBaseUrl(event.target.value)}
            placeholder="https://my-agent.example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        <FormField
          label="Registered agent identifier"
          htmlFor="checker-agent"
          hint="Optional. Once the agent is registered, the returned agentIdentifier is compared with it."
        >
          <Input
            id="checker-agent"
            value={agentIdentifier}
            onChange={(event) => setAgentIdentifier(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Endpoint" htmlFor="checker-endpoint" className="min-w-64 flex-1">
            <Select
              value={endpoint}
              onValueChange={(value) => setEndpoint(value as ProbeEndpointName)}
            >
              <SelectTrigger id="checker-endpoint">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENDPOINT_OPTIONS.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.method} {entry.path} · {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <Button type="button" onClick={runOne} disabled={!canRun}>
            {isRunning ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
            Check this endpoint
          </Button>
          <Button type="button" variant="outline" onClick={runSuite} disabled={!canRun}>
            <RefreshCw aria-hidden />
            Run basic checks
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{option.description}</p>

        {option.needs.includes('jobId') && (
          <FormField label="Job id" htmlFor="checker-job" required>
            <Input
              id="checker-job"
              value={jobId}
              onChange={(event) => setJobId(event.target.value)}
              autoComplete="off"
            />
          </FormField>
        )}
        {option.needs.includes('identifierFromPurchaser') && (
          <div className="space-y-4">
            <FormField
              label="identifier_from_purchaser"
              htmlFor="checker-identifier"
              required
              hint="The nonce your agent should echo back. Used to recompute the input hash."
            >
              <div className="flex gap-2">
                <Input
                  id="checker-identifier"
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
            <FormField
              label="input_data (JSON)"
              htmlFor="checker-input"
              hint="Flat object: one value per input field id."
            >
              <Textarea
                id="checker-input"
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                className="min-h-24 font-mono text-xs"
                spellCheck={false}
              />
            </FormField>
          </div>
        )}
        {endpoint === 'provide_input' && (
          <FormField
            label="input_schema_hash"
            htmlFor="checker-schema-hash"
            hint="SHA-256 of the input_schema your /status returned. The Hashes tool computes it."
          >
            <Input
              id="checker-schema-hash"
              value={schemaHash}
              onChange={(event) => setSchemaHash(event.target.value)}
              className="font-mono"
            />
          </FormField>
        )}
        {endpoint === 'start_job' && (
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={isFreeAgent}
              onCheckedChange={setIsFreeAgent}
              aria-label="This agent is free"
            />
            This agent is free (it only needs to return a job id)
          </label>
        )}
      </div>

      {result && (
        <div className="space-y-4">
          <CheckList checks={result.checks} />
          {result.response && <ResponseDetails probe={result.response} />}
        </div>
      )}
    </div>
  );
}
