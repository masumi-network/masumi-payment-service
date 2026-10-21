import type { AgentType } from './wizard';

/** Only Standard agents implement MIP-003 (/availability, /start_job, ...); the other types are read another way. */
export function runsMip003Jobs(type: AgentType): boolean {
  return type === 'Standard';
}

/** What the registry reads for an agent type instead of the MIP-003 endpoints, or null for Standard agents. */
export function registryReadsVia(type: AgentType): 'specification URL' | 'agent card' | null {
  if (type === 'A2A') return 'agent card';
  if (type === 'OpenApi' || type === 'X402') return 'specification URL';
  return null;
}
