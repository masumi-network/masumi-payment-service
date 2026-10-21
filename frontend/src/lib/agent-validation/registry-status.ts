import type { RegistryEntry } from '@/lib/api/generated';
import { getAgentStatusHelperText } from '../agent-status';
import { registryReadsVia } from './agent-type';
import type { ApiOutcome } from './api-outcome';
import { check, type ValidationCheck } from './checks';
import {
  findAgentsSharingBaseUrl,
  registrationFailureCheck,
  registrationProgress,
  sharedBaseUrlCheck,
} from './registration';
import type { SuiteProbeBody, SuiteProbeResult } from './suite';

const GENERIC_METADATA_FIX =
  'Fix the named fields by editing the agent (or register it again), so the registry can read it.';

/** Agents registered before the form required an author name have none, and the registry cannot read them. */
function metadataFix(message: string): string {
  return message.includes('author.name')
    ? 'Set an Author name: register the agent again and fill in Additional fields > Author name. The registry cannot read an agent without one.'
    : GENERIC_METADATA_FIX;
}

/** Why a registered agent is, or is not, showing up: its registration, its on-chain metadata and its live endpoint. */

const REGISTRY_DOCS_URL =
  'https://www.masumi.network/dev/masumi/documentation/technical-documentation/registry-metadata-standard';

export type RegistryStatusDeps = {
  probe: (body: SuiteProbeBody) => Promise<ApiOutcome<SuiteProbeResult>>;
  /** Reads the agent's metadata from the chain. A failure message names the invalid fields. */
  fetchMetadata: (agentIdentifier: string) => Promise<ApiOutcome<unknown>>;
};

export async function checkRegistryStatus(
  agent: RegistryEntry,
  agents: readonly RegistryEntry[],
  deps: RegistryStatusDeps,
): Promise<ValidationCheck[]> {
  const progress = registrationProgress(agent.state);
  const checks: ValidationCheck[] = [
    check(
      progress.tone === 'success' ? 'pass' : progress.tone === 'failed' ? 'fail' : 'warn',
      'registry.state',
      'Registration is confirmed on-chain',
      {
        detail:
          [progress.label, getAgentStatusHelperText(agent.state)].filter(Boolean).join('. ') + '.',
      },
    ),
  ];
  if (progress.tone === 'failed') checks.push(registrationFailureCheck(agent.error));

  if (progress.tone === 'success' && agent.agentIdentifier != null) {
    const metadata = await deps.fetchMetadata(agent.agentIdentifier);
    checks.push(
      metadata.ok
        ? check('pass', 'registry.metadata', 'On-chain metadata is valid')
        : check('fail', 'registry.metadata', 'On-chain metadata is valid', {
            detail: metadata.message,
            fix: metadataFix(metadata.message),
            docsUrl: REGISTRY_DOCS_URL,
          }),
    );
  }

  checks.push(...(await endpointChecks(agent, deps)));
  // The registry only probes the base URL of Standard agents, so only they can shadow each other there.
  if (agent.apiBaseUrl != null && agent.type === 'Standard') {
    checks.push(
      sharedBaseUrlCheck(findAgentsSharingBaseUrl(agents, agent.apiBaseUrl, agent.agentIdentifier)),
    );
  }
  return checks;
}

async function endpointChecks(
  agent: RegistryEntry,
  deps: RegistryStatusDeps,
): Promise<ValidationCheck[]> {
  const readsVia = registryReadsVia(agent.type);
  if (readsVia != null) {
    return [
      check('skipped', 'registry.endpoint', 'The live endpoint answers like the registry expects', {
        detail: `${agent.type} agents are checked by the registry through their ${readsVia}, not through /availability.`,
        fix: `Check that the ${readsVia} is public and valid.`,
        docsUrl: REGISTRY_DOCS_URL,
      }),
    ];
  }
  if (agent.apiBaseUrl == null) {
    return [
      check('fail', 'registry.endpoint', 'The live endpoint answers like the registry expects', {
        detail: 'The agent has no base URL, so the registry has nothing to check.',
        fix: 'Edit the agent and add its public base URL.',
        docsUrl: REGISTRY_DOCS_URL,
      }),
    ];
  }
  const outcome = await deps.probe({
    apiBaseUrl: agent.apiBaseUrl,
    endpoint: 'availability',
    ...(agent.agentIdentifier != null ? { expectedAgentIdentifier: agent.agentIdentifier } : {}),
  });
  if (!outcome.ok) {
    return [
      check('fail', 'registry.probe_failed', 'The live endpoint could be checked', {
        detail: outcome.message,
        fix: 'Check that the payment service is reachable, then run the check again.',
      }),
    ];
  }
  return outcome.data.Checks;
}
