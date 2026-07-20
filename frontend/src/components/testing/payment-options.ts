import type { PaymentSourceExtended, RegistryEntry } from '@/lib/api/generated';
import { getCardanoPricingOptions } from '@/lib/registry-pricing';

export type PaidAgentOption = {
  optionId: string;
  agentId: string;
  agentIdentifier: string;
  name: string;
  label: string;
  pricingType: 'Fixed' | 'Dynamic';
  paymentSourceType: PaymentSourceExtended['paymentSourceType'];
  supportedPaymentSourceIndex?: number;
};

function isConfirmedAgent(agent: RegistryEntry): boolean {
  return agent.state === 'RegistrationConfirmed' || agent.state === 'UpdateConfirmed';
}

export function buildPaidAgentOptions(
  agents: RegistryEntry[],
  paymentSourceType: PaymentSourceExtended['paymentSourceType'] | undefined,
): PaidAgentOption[] {
  if (!paymentSourceType) return [];

  return agents.flatMap((agent) => {
    if (!isConfirmedAgent(agent) || agent.agentIdentifier == null) return [];

    const paidOptions = getCardanoPricingOptions(agent).filter(
      (option) =>
        option.pricing.pricingType === 'Fixed' || option.pricing.pricingType === 'Dynamic',
    );

    return paidOptions.map((option, optionIndex) => {
      const supportedPaymentSourceIndex = option.supportedPaymentSourceIndex;
      const hasMultipleOptions = paidOptions.length > 1;

      return {
        optionId: `${agent.id}:${supportedPaymentSourceIndex ?? 'legacy'}`,
        agentId: agent.id,
        agentIdentifier: agent.agentIdentifier!,
        name: agent.name,
        label: hasMultipleOptions ? `${agent.name} · Masumi option ${optionIndex + 1}` : agent.name,
        pricingType: option.pricing.pricingType as 'Fixed' | 'Dynamic',
        paymentSourceType,
        ...(supportedPaymentSourceIndex == null ? {} : { supportedPaymentSourceIndex }),
      };
    });
  });
}
