import type { RegistryEntry } from '@/lib/api/generated';

export const UNSUPPORTED_AGENT_UPDATE_MESSAGE =
  'Updating OpenApi/X402/A2A agents is not yet supported';

export function supportsAgentMetadataUpdate(agent: Pick<RegistryEntry, 'type'>): boolean {
  return (agent.type ?? 'Standard') === 'Standard';
}

export function assertAgentMetadataUpdateSupported(agent: Pick<RegistryEntry, 'type'>): void {
  if (!supportsAgentMetadataUpdate(agent)) {
    throw new Error(UNSUPPORTED_AGENT_UPDATE_MESSAGE);
  }
}
