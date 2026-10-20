import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { postPaymentResolveBlockchainIdentifier } from '@/lib/api/generated';
import { settle } from '@/lib/agent-validation/api-outcome';
import { check, type ValidationCheck } from '@/lib/agent-validation/checks';
import { formatInputJson, parseInputJson } from '@/lib/agent-validation/input-json';
import {
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
  compareResultHash,
  describePhase,
  isTerminalStatus,
  phaseOf,
  readJobStatus,
} from '@/lib/agent-validation/job-flow';
import { sampleInputFor } from '@/lib/agent-validation/sample-input';
import type { JobProgress } from '@/lib/agent-validation/wizard';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useAgentValidationApi } from '@/lib/hooks/useAgentValidationApi';
import { CheckList } from './CheckList';
import type { JobTarget } from './JobStartPanel';

const ON_CHAIN_POLL_MS = POLL_INTERVAL_MS * 2;

/**
 * Step "Job lifecycle": follows the job from payment to result. It answers human-in-the-loop requests, checks
 * that the result is a proper string, and compares the hash the agent submitted on-chain with the one
 * computed from the result it returned.
 */
export function JobLifecyclePanel({
  target,
  job,
  onFinished,
}: {
  target: JobTarget;
  job: JobProgress;
  /** Called with every finding when the developer records the outcome. Omit to hide the button. */
  onFinished?: (checks: ValidationCheck[]) => void;
}) {
  const api = useAgentValidationApi();
  const queryClient = useQueryClient();
  const { apiClient, network } = useAppContext();
  const [answerDraft, setAnswerDraft] = useState<string | null>(null);
  const [hitlChecks, setHitlChecks] = useState<ValidationCheck[]>([]);
  const [isSending, setIsSending] = useState(false);

  const statusKey = ['agent-validation', 'status', target.apiBaseUrl, job.jobId];
  const statusQuery = useQuery({
    queryKey: statusKey,
    queryFn: async () => {
      const outcome = await api.probe({
        apiBaseUrl: target.apiBaseUrl,
        endpoint: 'status',
        jobId: job.jobId ?? '',
      });
      if (!outcome.ok) throw new Error(outcome.message);
      return outcome.data;
    },
    enabled: job.jobId != null,
    retry: 1,
    refetchInterval: (query) =>
      isTerminalStatus(readJobStatus(query.state.data?.bodyText ?? null).status) ||
      query.state.dataUpdateCount >= MAX_POLL_ATTEMPTS
        ? false
        : POLL_INTERVAL_MS,
  });

  const pollCount = queryClient.getQueryState(statusKey)?.dataUpdateCount ?? 0;
  const info = readJobStatus(statusQuery.data?.bodyText ?? null);
  const phase = phaseOf(info.status);
  const isDone = phase === 'finished' || phase === 'failed';
  const hasPayment = !target.isFreeAgent && job.blockchainIdentifier != null;

  const resultHashQuery = useQuery({
    queryKey: ['agent-validation', 'result-hash', job.identifierFromPurchaser, info.result],
    queryFn: async () => {
      const outcome = await api.hash({
        kind: 'result',
        identifierFromPurchaser: job.identifierFromPurchaser,
        result: info.result ?? '',
      });
      if (!outcome.ok) throw new Error(outcome.message);
      return outcome.data;
    },
    enabled: phase === 'finished' && info.result != null,
  });

  const paymentQuery = useQuery({
    queryKey: ['agent-validation', 'payment', job.blockchainIdentifier],
    queryFn: async () => {
      const outcome = await settle(
        () =>
          postPaymentResolveBlockchainIdentifier({
            client: apiClient,
            body: { blockchainIdentifier: job.blockchainIdentifier ?? '', network },
          }),
        'The payment could not be read',
      );
      if (!outcome.ok) throw new Error(outcome.message);
      return outcome.data;
    },
    enabled: phase === 'finished' && hasPayment,
    refetchInterval: (query) => (query.state.data?.resultHash ? false : ON_CHAIN_POLL_MS),
  });

  const sampleAnswer = formatInputJson(sampleInputFor(info.inputSchema));
  const answerText = answerDraft ?? sampleAnswer;

  async function sendAnswer() {
    const parsed = parseInputJson(answerText);
    if (!parsed.ok) {
      setHitlChecks([
        check('fail', 'lifecycle.hitl_input', 'The answer is valid JSON', {
          detail: parsed.message,
        }),
      ]);
      return;
    }
    setIsSending(true);
    const schemaHash = await api.hash({
      kind: 'input_schema',
      json: JSON.stringify(info.inputSchema),
    });
    if (!schemaHash.ok) {
      setHitlChecks([
        check('fail', 'lifecycle.hitl_hash', 'The input schema could be hashed', {
          detail: schemaHash.message,
        }),
      ]);
      setIsSending(false);
      return;
    }
    const outcome = await api.probe({
      apiBaseUrl: target.apiBaseUrl,
      endpoint: 'provide_input',
      jobId: job.jobId ?? '',
      identifierFromPurchaser: job.identifierFromPurchaser,
      inputData: parsed.data,
      inputSchemaHash: schemaHash.data.hash,
    });
    setHitlChecks(
      outcome.ok
        ? outcome.data.Checks
        : [
            check('fail', 'lifecycle.hitl_probe', 'The answer could be sent', {
              detail: outcome.message,
            }),
          ],
    );
    setAnswerDraft(null);
    setIsSending(false);
    await statusQuery.refetch();
  }

  const lifecycleChecks: ValidationCheck[] = [];
  if (phase === 'finished') {
    lifecycleChecks.push(check('pass', 'lifecycle.completed', 'The job completed with a result'));
    if (hasPayment && resultHashQuery.data && paymentQuery.data) {
      lifecycleChecks.push(
        compareResultHash(resultHashQuery.data.hash, paymentQuery.data.resultHash),
      );
    } else if (hasPayment && (resultHashQuery.isError || paymentQuery.isError)) {
      lifecycleChecks.push(
        check('warn', 'lifecycle.result_hash', 'The result hash could be compared', {
          detail: 'The payment or the hash could not be read.',
          fix: 'Check the payment under Transactions, then run this step again.',
        }),
      );
    }
  }
  if (phase === 'failed') {
    lifecycleChecks.push(
      check('fail', 'lifecycle.job_failed', 'The job completed', {
        detail: 'The agent reported the job as failed.',
        fix: "Look at your agent's logs for the reason. A failed job can be refunded to the buyer.",
      }),
    );
  }
  if (!isDone && pollCount >= MAX_POLL_ATTEMPTS) {
    lifecycleChecks.push(
      check('warn', 'lifecycle.timeout', 'The job finished in time', {
        detail: `The job was still ${info.status ?? 'unknown'} after ${Math.round((MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60000)} minutes.`,
        fix: 'Is the agent waiting for the payment to confirm, or stuck? Look at its logs and at the purchase under Transactions.',
      }),
    );
  }
  const statusChecks = statusQuery.data?.Checks ?? [];
  const allChecks = [...statusChecks, ...hitlChecks, ...lifecycleChecks];
  const isOnChainPending = phase === 'finished' && hasPayment && !paymentQuery.data?.resultHash;

  return (
    <div className="space-y-6">
      <div className="space-y-2 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              phase === 'finished' ? 'success' : phase === 'failed' ? 'destructive' : 'processing'
            }
          >
            {info.status ?? 'waiting for the first answer'}
          </Badge>
          {!isDone && statusQuery.isFetching && (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
          )}
          <span className="text-xs text-muted-foreground">
            Job {job.jobId} · asks the agent every {POLL_INTERVAL_MS / 1000} s
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{describePhase(phase)}</p>
        {statusQuery.isError && (
          <p role="alert" className="text-sm text-destructive">
            {statusQuery.error.message}
          </p>
        )}
      </div>

      {phase === 'needs_input' && (
        <section className="space-y-3" aria-labelledby="hitl-heading">
          <h2 id="hitl-heading" className="text-base font-semibold">
            Your agent is asking for input
          </h2>
          <FormField
            label="Answer (JSON)"
            htmlFor="hitl-answer"
            hint="Pre-filled from the input schema your agent sent. Edit it if you like."
          >
            <Textarea
              id="hitl-answer"
              value={answerText}
              onChange={(event) => setAnswerDraft(event.target.value)}
              className="min-h-32 font-mono text-xs"
              spellCheck={false}
            />
          </FormField>
          <Button type="button" onClick={sendAnswer} disabled={isSending}>
            {isSending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            Send input
          </Button>
        </section>
      )}

      {phase === 'finished' && info.result != null && (
        <section className="space-y-2" aria-labelledby="result-heading">
          <h2 id="result-heading" className="text-base font-semibold">
            Result
          </h2>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
            {info.result}
          </pre>
          {isOnChainPending && (
            <p className="text-xs text-muted-foreground">
              Waiting for the agent to submit its result hash on-chain. This can take a few minutes.
            </p>
          )}
        </section>
      )}

      <CheckList
        checks={allChecks}
        emptyText="Waiting for the first answer from the agent."
        foldPassed
      />

      {onFinished && (
        <Button type="button" onClick={() => onFinished(allChecks)} disabled={!isDone}>
          Record results
        </Button>
      )}
    </div>
  );
}
