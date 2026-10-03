import type { PaymentSourceExtended } from '@/lib/api/generated';
import type { AgentRelation } from '@/lib/queries/useContextAgents';
import { isV2PaymentSource } from '@/lib/payment-source-type';

/** Same eligibility as the AI agents table pencil (V2 metadata update). */
export function canEditAgentMetadata(params: {
  relation: AgentRelation | undefined;
  canPay: boolean;
  selectedPaymentSource: PaymentSourceExtended | null | undefined;
}): boolean {
  return (
    params.relation !== 'payment' &&
    params.canPay &&
    !!params.selectedPaymentSource &&
    isV2PaymentSource(params.selectedPaymentSource)
  );
}
