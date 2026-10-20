import type { NetworkType } from '@/lib/contexts/AppContext';
import { hasFailures, type CheckStatus, type ValidationCheck } from './checks';
import { isPlainObject } from '../object-properties';
import type { InputData } from './sample-input';

/**
 * State of the guided validation wizard. All of it is plain data so it can be saved per network and
 * restored after a reload: the job lifecycle waits on the chain for minutes, and losing the wizard
 * halfway through would mean paying for a second mock purchase.
 */

export type StepId =
  | 'intent'
  | 'node'
  | 'build'
  | 'endpoints'
  | 'register'
  | 'purchase'
  | 'lifecycle'
  | 'report';
export type Subject = 'agent' | 'coworker';
export type Goal = 'new' | 'registered' | 'endpoints';
export type AgentType = 'Standard' | 'OpenApi' | 'X402' | 'A2A';

export type WizardAnswers = {
  subject: Subject;
  goal: Goal;
  agentType: AgentType;
  apiBaseUrl: string;
  agentIdentifier: string | null;
  /** The registry request created by this wizard's registration, so its progress can be followed after a reload. */
  registryRequestId: string | null;
  isFreeAgent: boolean;
};

export type StepResult = { checks: ValidationCheck[]; at: string; acknowledged: boolean };

export type JobProgress = {
  identifierFromPurchaser: string;
  inputData: InputData;
  jobId: string | null;
  blockchainIdentifier: string | null;
  purchaseId: string | null;
};

export type WizardState = {
  version: 1;
  network: NetworkType;
  step: StepId;
  answers: WizardAnswers;
  results: Partial<Record<StepId, StepResult>>;
  job: JobProgress | null;
};

export const STEP_LABELS: Record<StepId, string> = {
  intent: 'Goal',
  node: 'Node ready',
  build: 'Build',
  endpoints: 'Endpoints',
  register: 'Register',
  purchase: 'Start a job',
  lifecycle: 'Job lifecycle',
  report: 'Report',
};

/** Steps that run checks and must have a result before the developer can move on. */
const CHECKED_STEPS: ReadonlySet<StepId> = new Set(['node', 'endpoints', 'lifecycle']);

export function createWizardState(network: NetworkType): WizardState {
  return {
    version: 1,
    network,
    step: 'intent',
    answers: {
      subject: 'agent',
      goal: 'new',
      agentType: 'Standard',
      apiBaseUrl: '',
      agentIdentifier: null,
      registryRequestId: null,
      isFreeAgent: false,
    },
    results: {},
    job: null,
  };
}

export function updateAnswers(state: WizardState, changes: Partial<WizardAnswers>): WizardState {
  return { ...state, answers: { ...state.answers, ...changes } };
}

export function stepsFor(answers: WizardAnswers, network: NetworkType): StepId[] {
  if (answers.subject === 'coworker') return ['intent', 'build', 'report'];
  if (answers.goal === 'endpoints') return ['intent', 'endpoints', 'report'];
  // A paid job moves real funds on Mainnet, so the mock purchase only exists on Preprod. A free agent costs nothing.
  const hasJob = network === 'Preprod' || answers.isFreeAgent;
  const journey: StepId[] =
    answers.goal === 'new'
      ? ['intent', 'node', 'build', 'endpoints', 'register']
      : ['intent', 'node', 'endpoints'];
  return [...journey, ...(hasJob ? (['purchase', 'lifecycle'] as StepId[]) : []), 'report'];
}

export function nextStep(state: WizardState): StepId | null {
  const steps = stepsFor(state.answers, state.network);
  const index = steps.indexOf(state.step);
  if (index === -1) return steps[0];
  return steps[index + 1] ?? null;
}

export function previousStep(state: WizardState): StepId | null {
  const steps = stepsFor(state.answers, state.network);
  const index = steps.indexOf(state.step);
  return index > 0 ? steps[index - 1] : null;
}

export function recordResult(
  state: WizardState,
  step: StepId,
  checks: ValidationCheck[],
  at: string,
): WizardState {
  return { ...state, results: { ...state.results, [step]: { checks, at, acknowledged: false } } };
}

/** The developer chose to continue past failed checks. A later re-run clears this again. */
export function acknowledgeStep(state: WizardState, step: StepId): WizardState {
  const result = state.results[step];
  if (result == null) return state;
  return { ...state, results: { ...state.results, [step]: { ...result, acknowledged: true } } };
}

export type AdvanceBlock = { blocked: boolean; reason: string | null };

const OPEN: AdvanceBlock = { blocked: false, reason: null };
const blockedBy = (reason: string): AdvanceBlock => ({ blocked: true, reason });

/** Whether "Continue" is allowed on the current step, and if not, the reason to show next to the button. */
export function advanceBlock(state: WizardState): AdvanceBlock {
  const { step, answers, job } = state;
  switch (step) {
    case 'intent':
      return answers.subject === 'agent' &&
        answers.goal === 'registered' &&
        answers.agentIdentifier == null
        ? blockedBy('Pick the registered agent to test.')
        : OPEN;
    case 'register':
      if (answers.agentIdentifier == null) {
        return blockedBy('Register the agent and wait until it is confirmed.');
      }
      return state.results.register == null ? OPEN : checkedBlock(state, step);
    case 'purchase':
      if (job?.jobId == null) return blockedBy('Start a job first.');
      return answers.isFreeAgent || job.purchaseId != null
        ? OPEN
        : blockedBy('Pay for the job first.');
    case 'report':
      return blockedBy('This is the last step.');
    case 'build':
      return answers.subject === 'coworker' ? checkedBlock(state, step) : OPEN;
    default:
      return CHECKED_STEPS.has(step) ? checkedBlock(state, step) : OPEN;
  }
}

function checkedBlock(state: WizardState, step: StepId): AdvanceBlock {
  const result = state.results[step];
  if (result == null) {
    return blockedBy(
      step === 'lifecycle' ? 'Wait for the job to finish.' : 'Run the checks before continuing.',
    );
  }
  if (hasFailures(result.checks) && !result.acknowledged) {
    return blockedBy('Fix the failed checks, or choose "Continue anyway" to move on with them.');
  }
  return OPEN;
}

/** Every recorded result of the current journey, in journey order. */
export function allResults(state: WizardState): ({ step: StepId } & StepResult)[] {
  return stepsFor(state.answers, state.network).flatMap((step) => {
    const result = state.results[step];
    return result ? [{ step, ...result }] : [];
  });
}

// ---- persistence -------------------------------------------------------------------------------------

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const storageKey = (network: NetworkType) => `masumi_agent_validation_v1_${network}`;

const STEP_IDS = Object.keys(STEP_LABELS) as StepId[];
const CHECK_STATUSES: readonly CheckStatus[] = ['pass', 'warn', 'fail', 'skipped'];

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function parseCheck(value: unknown): ValidationCheck | null {
  if (!isPlainObject(value)) return null;
  const { id, status, label, detail, fix, docsUrl } = value;
  if (typeof id !== 'string' || typeof label !== 'string') return null;
  if (!CHECK_STATUSES.includes(status as CheckStatus)) return null;
  if (!isNullableString(detail) || !isNullableString(fix) || !isNullableString(docsUrl))
    return null;
  return { id, status: status as CheckStatus, label, detail, fix, docsUrl };
}

function parseResults(value: unknown): WizardState['results'] | null {
  if (!isPlainObject(value)) return null;
  const results: WizardState['results'] = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!STEP_IDS.includes(key as StepId) || !isPlainObject(entry)) return null;
    if (
      !Array.isArray(entry.checks) ||
      typeof entry.at !== 'string' ||
      typeof entry.acknowledged !== 'boolean'
    )
      return null;
    const checks = entry.checks.map(parseCheck);
    if (checks.some((parsed) => parsed === null)) return null;
    results[key as StepId] = {
      checks: checks as ValidationCheck[],
      at: entry.at,
      acknowledged: entry.acknowledged,
    };
  }
  return results;
}

function parseAnswers(value: unknown): WizardAnswers | null {
  if (!isPlainObject(value)) return null;
  const { subject, goal, agentType, apiBaseUrl, agentIdentifier, registryRequestId, isFreeAgent } =
    value;
  if (subject !== 'agent' && subject !== 'coworker') return null;
  if (goal !== 'new' && goal !== 'registered' && goal !== 'endpoints') return null;
  if (!['Standard', 'OpenApi', 'X402', 'A2A'].includes(agentType as string)) return null;
  if (
    typeof apiBaseUrl !== 'string' ||
    !isNullableString(agentIdentifier) ||
    !isNullableString(registryRequestId)
  )
    return null;
  if (typeof isFreeAgent !== 'boolean') return null;
  return {
    subject,
    goal,
    agentType: agentType as AgentType,
    apiBaseUrl,
    agentIdentifier,
    registryRequestId,
    isFreeAgent,
  };
}

function isInputValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function parseJob(value: unknown): JobProgress | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value) || !isPlainObject(value.inputData)) return undefined;
  const { identifierFromPurchaser, inputData, jobId, blockchainIdentifier, purchaseId } = value;
  if (typeof identifierFromPurchaser !== 'string') return undefined;
  if (
    !isNullableString(jobId) ||
    !isNullableString(blockchainIdentifier) ||
    !isNullableString(purchaseId)
  )
    return undefined;
  const entries = Object.entries(inputData);
  if (!entries.every(([, entry]) => isInputValue(entry))) return undefined;
  return {
    identifierFromPurchaser,
    inputData: Object.fromEntries(entries) as InputData,
    jobId,
    blockchainIdentifier,
    purchaseId,
  };
}

export function serializeWizard(state: WizardState): string {
  return JSON.stringify(state);
}

/** Parses saved state, returning null for anything that is not exactly what this version wrote. */
export function parseWizard(raw: string | null, network: NetworkType): WizardState | null {
  if (raw == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || value.version !== 1 || value.network !== network) return null;
  if (!STEP_IDS.includes(value.step as StepId)) return null;
  const answers = parseAnswers(value.answers);
  const results = parseResults(value.results);
  const job = parseJob(value.job);
  if (answers == null || results == null || job === undefined) return null;
  return { version: 1, network, step: value.step as StepId, answers, results, job };
}

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadWizard(
  network: NetworkType,
  storage: StorageLike | undefined = defaultStorage(),
): WizardState | null {
  try {
    return parseWizard(storage?.getItem(storageKey(network)) ?? null, network);
  } catch {
    return null;
  }
}

export function saveWizard(
  state: WizardState,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(storageKey(state.network), serializeWizard(state));
  } catch {
    // Storage can be blocked or full. The wizard still works; it just will not survive a reload.
  }
}

export function clearWizard(
  network: NetworkType,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  try {
    storage?.removeItem(storageKey(network));
  } catch {
    // See saveWizard.
  }
}
