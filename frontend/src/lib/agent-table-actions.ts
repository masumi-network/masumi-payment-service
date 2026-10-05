import type { RegistryEntry } from '@/lib/api/generated';
import type { AgentRelation } from '@/lib/queries/useContextAgents';
import { isDbDeletableAgentState, isDeregisterableAgentState } from './registry-states';
type AIAgent = RegistryEntry & { relation?: AgentRelation };

export function isBulkDeletableAgent(agent: AIAgent, canAdmin: boolean): boolean {
  return canAdmin && agent.relation !== 'payment' && isDbDeletableAgentState(agent.state);
}

export function isBulkDeregisterableAgent(agent: AIAgent, canPay: boolean): boolean {
  return (
    canPay &&
    agent.relation !== 'payment' &&
    isDeregisterableAgentState(agent.state) &&
    Boolean(agent.agentIdentifier?.trim())
  );
}
