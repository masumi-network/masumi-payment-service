import type { ApiOutcome } from './api-outcome';
import { check, type ValidationCheck } from './checks';

/** The standard endpoint checks: what the registry polls, what a buyer needs to build a form, and the optional demo. */

export type SuiteProbeBody = {
  apiBaseUrl: string;
  endpoint: 'availability' | 'input_schema' | 'demo';
  expectedAgentIdentifier?: string;
};

export type SuiteProbeResult = {
  httpStatus: number | null;
  durationMs: number;
  redirectedTo: string | null;
  bodyText: string | null;
  Checks: ValidationCheck[];
};

export type SuiteProbe = (body: SuiteProbeBody) => Promise<ApiOutcome<SuiteProbeResult>>;

export type SuiteOutcome = {
  checks: ValidationCheck[];
  /** The raw /input_schema response, for building sample input; null when it could not be fetched. */
  inputSchemaText: string | null;
};

const SUITE_ENDPOINTS = ['availability', 'input_schema', 'demo'] as const;

export async function runEndpointSuite(
  probe: SuiteProbe,
  options: { apiBaseUrl: string; expectedAgentIdentifier?: string },
): Promise<SuiteOutcome> {
  const checks: ValidationCheck[] = [];
  const seen = new Set<string>();
  const add = (entries: readonly ValidationCheck[]) => {
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      checks.push(entry);
    }
  };
  let inputSchemaText: string | null = null;

  for (const endpoint of SUITE_ENDPOINTS) {
    const outcome = await probe({
      apiBaseUrl: options.apiBaseUrl,
      endpoint,
      ...(endpoint === 'availability' && options.expectedAgentIdentifier
        ? { expectedAgentIdentifier: options.expectedAgentIdentifier }
        : {}),
    });
    if (!outcome.ok) {
      add([
        check('fail', 'suite.probe_failed', `GET /${endpoint} could be checked`, {
          detail: outcome.message,
          fix: 'Check that the payment service is reachable, then run the checks again.',
        }),
      ]);
      continue;
    }
    add(outcome.data.Checks);
    if (endpoint === 'input_schema') inputSchemaText = outcome.data.bodyText;
    // Nothing was sent (unusable URL) or the agent never answered: the remaining probes would only wait again.
    if (outcome.data.httpStatus == null) break;
  }
  return { checks, inputSchemaText };
}
