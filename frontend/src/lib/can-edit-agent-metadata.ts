import type { PaymentSourceExtended, RegistryEntry } from '@/lib/api/generated';
import type { AgentRelation } from '@/lib/queries/useContextAgents';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { supportsAgentMetadataUpdate } from './agent-update';

/** Same eligibility as the AI agents table pencil (V2 metadata update). */
export function canEditAgentMetadata(params: {
  agent: Pick<RegistryEntry, 'type'> | null | undefined;
  relation: AgentRelation | undefined;
  canPay: boolean;
  selectedPaymentSource: PaymentSourceExtended | null | undefined;
}): boolean {
  return (
    params.agent != null &&
    supportsAgentMetadataUpdate(params.agent) &&
    params.relation !== 'payment' &&
    params.canPay &&
    !!params.selectedPaymentSource &&
    isV2PaymentSource(params.selectedPaymentSource)
  );
}
