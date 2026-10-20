import type { RegistryEntry } from '@/lib/api/generated';
import { parseAgentStatus } from '../agent-status';
import { check, type ValidationCheck } from './checks';

/** The registration step: where a registration is, why it failed, and whether the base URL is shared. */

const REGISTER_DOCS_URL =
  'https://www.masumi.network/dev/masumi/documentation/get-started/register-agent';
const TOP_UP_DOCS_URL =
  'https://www.masumi.network/dev/masumi/documentation/how-to-guides/top-up-your-wallets';

export type RegistrationProgress = {
  tone: 'pending' | 'success' | 'failed';
  label: string;
  isDone: boolean;
};

export function registrationProgress(state: RegistryEntry['state']): RegistrationProgress {
  const tone = state.endsWith('Confirmed')
    ? 'success'
    : state.endsWith('Failed')
      ? 'failed'
      : 'pending';
  return { tone, label: parseAgentStatus(state), isDone: tone !== 'pending' };
}

type FailureRule = { id: string; label: string; pattern: RegExp; fix: string; docsUrl: string };

// Ordered: the first matching rule wins, so the most specific comes first (a phase-2 failure mentions
// "collateral consumed", which must not be read as a collateral-preparation problem). The patterns follow the messages the registration service writes
// (registerAgentV2 and blockchain-error-interpreter) and the transaction-timeout / phase-2 handlers.
const FAILURE_RULES: FailureRule[] = [
  {
    id: 'register.failed.funds',
    label: 'The selling wallet could pay for the registration',
    pattern: /balance too low|insufficient/i,
    fix: 'Top up the selling wallet (the node check shows how much it needs), then register again.',
    docsUrl: TOP_UP_DOCS_URL,
  },
  {
    id: 'register.failed.rejected',
    label: 'The network accepted the registration transaction',
    pattern: /phase-2|script rejected|validation failed/i,
    fix: 'The network rejected the transaction after it was submitted (collateral was consumed). Check the agent metadata (name, tags, pricing, URL) against the registry rules, top up the wallet, and register again.',
    docsUrl: REGISTER_DOCS_URL,
  },
  {
    id: 'register.failed.collateral',
    label: 'A collateral output could be prepared',
    pattern: /collateral/i,
    fix: 'Keep at least 5 ADA in the selling wallet beyond the registration fee: the node prepares a collateral output itself and retries. If it keeps failing, check the transaction errors under Transactions.',
    docsUrl: TOP_UP_DOCS_URL,
  },
  {
    id: 'register.failed.timeout',
    label: 'The registration transaction was confirmed in time',
    pattern: /timeout|force unlocked/i,
    fix: 'The transaction was not confirmed in time and its lock was released. Register again.',
    docsUrl: REGISTER_DOCS_URL,
  },
  {
    id: 'register.failed.provider',
    label: 'The Blockfrost API key could submit the transaction',
    pattern: /blockfrost|\b(402|403|429)\b|rate limit/i,
    fix: 'The Blockfrost API key was rejected or rate limited (HTTP 402, 403 or 429). Check the key and its plan in Payment Sources, then register again.',
    docsUrl: REGISTER_DOCS_URL,
  },
];

/** Turns the error stored on a failed registration into a finding with the next step. */
export function registrationFailureCheck(error: string | null): ValidationCheck {
  const detail = error ?? 'The registration failed without an error message.';
  const rule = error == null ? undefined : FAILURE_RULES.find((entry) => entry.pattern.test(error));
  if (rule) {
    return check('fail', rule.id, rule.label, { detail, fix: rule.fix, docsUrl: rule.docsUrl });
  }
  return check('fail', 'register.failed.unknown', 'The registration completed', {
    detail,
    fix: 'Read the error above, fix the cause, and register again. If it repeats, the transaction errors under Transactions show more.',
    docsUrl: REGISTER_DOCS_URL,
  });
}

function normalizeBaseUrl(raw: string): string | null {
  try {
    return new URL(raw.trim()).toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Other registered agents that use the same base URL. The registry keeps one health result per URL: when
 * /availability returns an agentIdentifier, only the agent with that id stays Online and every other one
 * on the URL becomes Invalid.
 */
export function findAgentsSharingBaseUrl(
  agents: readonly RegistryEntry[],
  apiBaseUrl: string,
  ownAgentIdentifier: string | null,
): RegistryEntry[] {
  const wanted = normalizeBaseUrl(apiBaseUrl);
  if (wanted == null) return [];
  return agents.filter(
    (entry) =>
      (entry.state === 'RegistrationConfirmed' || entry.state === 'UpdateConfirmed') &&
      entry.apiBaseUrl != null &&
      entry.agentIdentifier !== ownAgentIdentifier &&
      normalizeBaseUrl(entry.apiBaseUrl) === wanted,
  );
}

export function sharedBaseUrlCheck(sharing: readonly RegistryEntry[]): ValidationCheck {
  const id = 'register.shared_base_url';
  const label = 'No other registered agent uses this base URL';
  if (sharing.length === 0) return check('pass', id, label);
  return check('warn', id, label, {
    detail: `${sharing.map((entry) => entry.name).join(', ')} ${sharing.length === 1 ? 'is' : 'are'} registered with the same base URL. If /availability returns an agentIdentifier, the registry keeps only that agent Online and marks the others Invalid.`,
    fix: 'Give every agent its own base URL (for example a different subdomain or path prefix).',
    docsUrl: REGISTER_DOCS_URL,
  });
}
