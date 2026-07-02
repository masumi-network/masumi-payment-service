import type { RegistryEntry } from '@/lib/api/generated';

export type AgentState = RegistryEntry['state'];

/**
 * States from which the backend accepts an on-chain deregistration
 * (POST /registry/deregister). Must stay in sync with
 * `validStatesForDeregister` in src/routes/api/registry/deregister/index.ts —
 * the in-flight states (Registration/Update/Deregistration Requested and
 * Initiated) are excluded there because a scheduler is already driving them.
 */
export const DEREGISTERABLE_AGENT_STATES: readonly AgentState[] = [
  'RegistrationConfirmed',
  'UpdateConfirmed',
  'UpdateFailed',
  'DeregistrationFailed',
];

/**
 * Terminal failure/off-chain states where the row can simply be removed from
 * the database (DELETE /registry) — nothing is on-chain to burn.
 */
export const DB_DELETABLE_AGENT_STATES: readonly AgentState[] = [
  'RegistrationFailed',
  'DeregistrationConfirmed',
];

export function isDeregisterableAgentState(state: AgentState | undefined): boolean {
  return state != null && DEREGISTERABLE_AGENT_STATES.includes(state);
}

export function isDbDeletableAgentState(state: AgentState | undefined): boolean {
  return state != null && DB_DELETABLE_AGENT_STATES.includes(state);
}
