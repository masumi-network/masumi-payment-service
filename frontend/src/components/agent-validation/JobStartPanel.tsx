import { useState } from 'react';
import { Loader2, Lock, Play, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { buildPaidAgentOptions } from '@/components/testing/payment-options';
import {
  postPaymentResolveBlockchainIdentifier,
  postPurchase,
  type Payment,
} from '@/lib/api/generated';
import { settle } from '@/lib/agent-validation/api-outcome';
import { check, type ValidationCheck } from '@/lib/agent-validation/checks';
import { formatInputJson, parseInputJson } from '@/lib/agent-validation/input-json';
import { readStartJob } from '@/lib/agent-validation/job-flow';
import {
  buildPurchaseBody,
  choosePaymentSourceIndex,
  describeFunds,
  describeUnixMs,
  newIdentifierFromPurchaser,
  purchaseFailureCheck,
} from '@/lib/agent-validation/purchase';
import { sampleInputFor } from '@/lib/agent-validation/sample-input';
import type { JobProgress } from '@/lib/agent-validation/wizard';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useAgentValidationApi } from '@/lib/hooks/useAgentValidationApi';
import { useResync } from '@/lib/hooks/useResync';
import { useAllAgents } from '@/lib/queries/useAgents';
import { CheckList } from './CheckList';

export type JobTarget = {
  apiBaseUrl: string;
  agentIdentifier: string | null;
  isFreeAgent: boolean;
};

type Stages = { start: ValidationCheck[]; payment: ValidationCheck[]; purchase: ValidationCheck[] };
type Busy = 'sample' | 'start' | 'lookup' | 'buy' | null;

const NO_STAGES: Stages = { start: [], payment: [], purchase: [] };

/**
 * Step "Start a job": call the agent's /start_job, find the payment it created on this node, and, on Preprod
 * and after an explicit confirmation, lock test funds with a purchase exactly as a real buyer would.
 */
export function JobStartPanel({
  target,
  job,
  onJobChange,
  onChecks,
}: {
  target: JobTarget;
  job: JobProgress | null;
  onJobChange: (job: JobProgress | null) => void;
  onChecks: (checks: ValidationCheck[]) => void;
}) {
  const api = useAgentValidationApi();
  const { apiClient, network, selectedPaymentSource } = useAppContext();
  const { agents } = useAllAgents();
  const resync = useResync();
  const [inputText, setInputText] = useState(() => formatInputJson(job?.inputData ?? {}));
  const [stages, setStages] = useState<Stages>(NO_STAGES);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [startedIndex, setStartedIndex] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);

  const canSpend = network === 'Preprod';
  const needsPayment = !target.isFreeAgent;

  function commit(next: Partial<Stages>) {
    const merged = { ...stages, ...next };
    setStages(merged);
    onChecks([...merged.start, ...merged.payment, ...merged.purchase]);
  }

  async function loadSample() {
    setBusy('sample');
    const outcome = await api.probe({ apiBaseUrl: target.apiBaseUrl, endpoint: 'input_schema' });
    if (outcome.ok && outcome.data.bodyText) {
      try {
        setInputText(formatInputJson(sampleInputFor(JSON.parse(outcome.data.bodyText))));
        setBusy(null);
        return;
      } catch {
        // fall through to the message below
      }
    }
    commit({
      start: [
        check('warn', 'job.sample', 'Sample input could be built from the agent', {
          detail: outcome.ok
            ? "The agent's /input_schema did not return JSON this tool could read."
            : outcome.message,
          fix: 'Run the endpoint checks first and fix the input schema, or type the input by hand.',
        }),
      ],
    });
    setBusy(null);
  }

  async function startJob() {
    const parsed = parseInputJson(inputText);
    if (!parsed.ok) {
      commit({
        start: [check('fail', 'job.input', 'The input is valid JSON', { detail: parsed.message })],
      });
      return;
    }
    setBusy('start');
    setPayment(null);
    setConfirmed(false);
    const identifierFromPurchaser = newIdentifierFromPurchaser();
    const outcome = await api.probe({
      apiBaseUrl: target.apiBaseUrl,
      endpoint: 'start_job',
      identifierFromPurchaser,
      inputData: parsed.data,
      isFreeAgent: target.isFreeAgent,
      ...(target.agentIdentifier ? { expectedAgentIdentifier: target.agentIdentifier } : {}),
    });
    if (!outcome.ok) {
      commit({
        start: [
          check('fail', 'job.probe_failed', 'The job could be started', {
            detail: outcome.message,
          }),
        ],
        payment: [],
        purchase: [],
      });
      onJobChange(null);
      setBusy(null);
      return;
    }
    const info = readStartJob(outcome.data.bodyText);
    setStartedIndex(info.supportedPaymentSourceIndex);
    commit({ start: outcome.data.Checks, payment: [], purchase: [] });
    onJobChange(
      info.jobId == null
        ? null
        : {
            identifierFromPurchaser,
            inputData: parsed.data,
            jobId: info.jobId,
            blockchainIdentifier: info.blockchainIdentifier,
            purchaseId: null,
          },
    );
    setBusy(null);
  }

  async function lookUpPayment() {
    if (job?.blockchainIdentifier == null) return;
    setBusy('lookup');
    const outcome = await settle(
      () =>
        postPaymentResolveBlockchainIdentifier({
          client: apiClient,
          body: { blockchainIdentifier: job.blockchainIdentifier ?? '', network },
        }),
      'The payment could not be looked up',
    );
    if (outcome.ok) {
      setPayment(outcome.data);
      commit({
        payment: [
          check('pass', 'purchase.payment_found', 'The agent created its payment on this node', {
            detail: `It asks for ${describeFunds(outcome.data.RequestedFunds)}; the funds unlock at ${describeUnixMs(outcome.data.unlockTime)}.`,
          }),
        ],
      });
    } else {
      setPayment(null);
      commit({
        payment: [
          check('fail', 'purchase.payment_found', 'The agent created its payment on this node', {
            detail: outcome.message,
            fix: 'Your agent must create its payment on this node: point its payment service URL (PAYMENT_SERVICE_URL) and API key at this node, then start a new job. A lookup only finds payments created through this node.',
          }),
        ],
      });
    }
    setBusy(null);
  }

  async function lockFunds() {
    if (job == null || payment == null) return;
    const choice = choosePaymentSourceIndex({
      isV2: selectedPaymentSource?.paymentSourceType === 'Web3CardanoV2',
      startedIndex,
      candidateIndexes: buildPaidAgentOptions(agents, selectedPaymentSource?.paymentSourceType)
        .filter((option) => option.agentIdentifier === payment.agentIdentifier)
        .map((option) => option.supportedPaymentSourceIndex),
    });
    if (!choice.ok) {
      commit({
        purchase: [
          check('fail', 'purchase.source_index', 'The purchase knows which payment source to use', {
            detail: choice.problem,
            fix: 'Return supportedPaymentSourceIndex from /start_job, or register the agent with a single paid option. A purchase against the wrong source would lock funds at the wrong price.',
          }),
        ],
      });
      return;
    }
    const built = buildPurchaseBody(payment, {
      network,
      identifierFromPurchaser: job.identifierFromPurchaser,
      supportedPaymentSourceIndex: choice.index,
    });
    if (!built.ok) {
      commit({
        purchase: [
          check('fail', 'purchase.incomplete', 'The payment has everything a purchase needs', {
            detail: built.problems.join(' '),
            fix: 'The agent created an incomplete payment. Start a new job once it creates its payment with all terms.',
          }),
        ],
      });
      return;
    }
    setBusy('buy');
    const outcome = await settle(
      () => postPurchase({ client: apiClient, body: built.body }),
      'The purchase was rejected',
    );
    if (outcome.ok) {
      onJobChange({ ...job, purchaseId: outcome.data.id });
      commit({
        purchase: [
          check('pass', 'purchase.created', 'The purchase was accepted', {
            detail:
              'The funds are being locked on-chain. The agent starts working once it sees the payment.',
          }),
        ],
      });
      await resync('purchases');
    } else {
      commit({ purchase: [purchaseFailureCheck(outcome.message)] });
    }
    setBusy(null);
  }

  const hasJob = job?.jobId != null;
  const canLookUp = hasJob && needsPayment && job?.blockchainIdentifier != null;

  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-labelledby="job-start-heading">
        <h2 id="job-start-heading" className="text-base font-semibold">
          1. Start the job
        </h2>
        <FormField
          label="input_data (JSON)"
          htmlFor="job-input"
          hint="One value per input field id of your agent."
        >
          <Textarea
            id="job-input"
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            className="min-h-32 font-mono text-xs"
            spellCheck={false}
          />
        </FormField>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={loadSample} disabled={busy != null}>
            {busy === 'sample' ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Search aria-hidden />
            )}
            Fill from my agent&apos;s input schema
          </Button>
          <Button type="button" onClick={startJob} disabled={busy != null}>
            {busy === 'start' ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Play aria-hidden />
            )}
            Start job
          </Button>
        </div>
        {stages.start.length > 0 && <CheckList checks={stages.start} foldPassed />}
      </section>

      {hasJob && needsPayment && (
        <section className="space-y-4" aria-labelledby="job-pay-heading">
          <h2 id="job-pay-heading" className="text-base font-semibold">
            2. Pay for the job
          </h2>
          {!canSpend ? (
            <p className="text-sm text-muted-foreground">
              A purchase moves real funds on {network}, so the mock purchase only runs on Preprod.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Your agent has created its payment. Find it on this node, then lock test funds with
                a purchase, exactly as a buyer would.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={lookUpPayment}
                disabled={busy != null || !canLookUp}
              >
                {busy === 'lookup' ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Search aria-hidden />
                )}
                Look up the payment
              </Button>
              {stages.payment.length > 0 && <CheckList checks={stages.payment} />}
              {payment != null && job?.purchaseId == null && (
                <div className="space-y-3 rounded-lg border p-4">
                  <p className="text-sm">
                    This locks <strong>{describeFunds(payment.RequestedFunds)}</strong> from the
                    purchasing wallet in the escrow contract until the agent submits its result or
                    the refund period ends ({describeUnixMs(payment.unlockTime)}).
                  </p>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      className="mt-1"
                    />
                    <span>I understand this spends {network} test funds.</span>
                  </label>
                  <Button type="button" onClick={lockFunds} disabled={busy != null || !confirmed}>
                    {busy === 'buy' ? (
                      <Loader2 className="animate-spin" aria-hidden />
                    ) : (
                      <Lock aria-hidden />
                    )}
                    Lock funds (create purchase)
                  </Button>
                </div>
              )}
              {stages.purchase.length > 0 && <CheckList checks={stages.purchase} />}
            </>
          )}
        </section>
      )}
    </div>
  );
}
