import { check, type ValidationCheck } from './checks';
import { getOwnValue, isPlainObject, type RuntimeValue } from '../object-properties';

/** Reading the agent's job responses, and deciding what the lifecycle step does next. */

const MAX_PAYMENT_SOURCE_INDEX = 24;
const MIP_004_URL =
  'https://github.com/masumi-network/masumi-improvement-proposals/blob/main/MIPs/MIP-004/MIP-004.md';

export const POLL_INTERVAL_MS = 5_000;
/** About 30 minutes of polling before the wizard stops and says what is still pending. */
export const MAX_POLL_ATTEMPTS = 360;

function parseJson(text: string | null): RuntimeValue {
  if (text == null) return undefined;
  try {
    return JSON.parse(text) as RuntimeValue;
  } catch {
    return undefined;
  }
}

function parsePaymentSourceIndex(value: RuntimeValue): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_PAYMENT_SOURCE_INDEX
    ? parsed
    : null;
}

export type StartJobInfo = {
  jobId: string | null;
  blockchainIdentifier: string | null;
  supportedPaymentSourceIndex: number | null;
};

/** The job id (`id`, or `job_id` as some SDKs send it) and the payment source index out of a start_job body. */
export function readStartJob(bodyText: string | null): StartJobInfo {
  const body = parseJson(bodyText);
  if (!isPlainObject(body))
    return { jobId: null, blockchainIdentifier: null, supportedPaymentSourceIndex: null };
  const id = getOwnValue(body, 'id');
  const legacyId = getOwnValue(body, 'job_id');
  const jobId =
    typeof id === 'string' && id.length > 0
      ? id
      : typeof legacyId === 'string' && legacyId.length > 0
        ? legacyId
        : null;
  const blockchainIdentifier = getOwnValue(body, 'blockchainIdentifier');
  return {
    jobId,
    blockchainIdentifier:
      typeof blockchainIdentifier === 'string' && blockchainIdentifier.length > 0
        ? blockchainIdentifier
        : null,
    supportedPaymentSourceIndex: parsePaymentSourceIndex(
      getOwnValue(body, 'supportedPaymentSourceIndex'),
    ),
  };
}

export type JobStatusInfo = {
  status: string | null;
  result: string | null;
  inputSchema: RuntimeValue;
};

export function readJobStatus(bodyText: string | null): JobStatusInfo {
  const body = parseJson(bodyText);
  if (!isPlainObject(body)) return { status: null, result: null, inputSchema: null };
  const status = getOwnValue(body, 'status');
  const result = getOwnValue(body, 'result');
  return {
    status: typeof status === 'string' ? status : null,
    result: typeof result === 'string' ? result : null,
    inputSchema: getOwnValue(body, 'input_schema') ?? null,
  };
}

export function isTerminalStatus(status: string | null): boolean {
  return status === 'completed' || status === 'failed';
}

export type LifecyclePhase =
  | 'waiting_for_payment'
  | 'running'
  | 'needs_input'
  | 'finished'
  | 'failed'
  | 'unknown';

export function phaseOf(status: string | null): LifecyclePhase {
  switch (status) {
    case 'awaiting_payment':
      return 'waiting_for_payment';
    case 'running':
      return 'running';
    case 'awaiting_input':
      return 'needs_input';
    case 'completed':
      return 'finished';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

const PHASE_TEXT: Record<LifecyclePhase, string> = {
  waiting_for_payment: 'The agent is waiting for the payment to be confirmed on-chain.',
  running: 'The agent has seen the payment and is working on the job.',
  needs_input: 'The agent needs more input from you (human in the loop).',
  finished: 'The agent finished the job and returned a result.',
  failed: 'The agent reports that the job failed.',
  unknown: 'The agent returned a status this tool does not recognise.',
};

export function describePhase(phase: LifecyclePhase): string {
  return PHASE_TEXT[phase];
}

const RESULT_HASH_ID = 'lifecycle.result_hash';
const RESULT_HASH_LABEL = 'Result hash on-chain matches the hash we compute';

/** Compares the hash the agent submitted on-chain with the MIP-004 result hash computed from its returned result. */
export function compareResultHash(computed: string, onChain: string | null): ValidationCheck {
  if (onChain == null || onChain.length === 0) {
    return check('warn', RESULT_HASH_ID, RESULT_HASH_LABEL, {
      detail: 'The agent has not submitted a result hash on-chain yet.',
      fix: 'Wait for the agent to submit its result. If it never does, the buyer can request a refund once the submit-result time has passed.',
      docsUrl: MIP_004_URL,
    });
  }
  if (onChain === computed) return check('pass', RESULT_HASH_ID, RESULT_HASH_LABEL);
  return check('fail', RESULT_HASH_ID, RESULT_HASH_LABEL, {
    detail: `The agent submitted ${onChain} on-chain, but the result it returned hashes to ${computed}.`,
    fix: 'Hash identifier_from_purchaser + ";" + the JSON-escaped result with SHA-256 (MIP-004), and submit exactly that.',
    docsUrl: MIP_004_URL,
  });
}
