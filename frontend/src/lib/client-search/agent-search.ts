import { RegistryEntry } from '@/lib/api/generated';
import { parseAmountSearchRange, parseAmountToBigInt } from '@/lib/parseAmountSearchRange';
import { getPrimaryCardanoPricing } from '@/lib/registry-pricing';

/**
 * Client-side agent search while server results are pending.
 * Mirrors the Prisma OR filter in src/routes/api/registry/index.ts.
 */
export function filterAgentsClientSide<T extends RegistryEntry>(
  agents: T[],
  searchQuery: string,
): T[] {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return agents;

  const amountRange = parseAmountSearchRange(query);

  return agents.filter((agent) => {
    const pricing = getPrimaryCardanoPricing(agent);
    if (agent.name?.toLowerCase().includes(query)) return true;
    if (agent.description?.toLowerCase().includes(query)) return true;
    if (agent.Tags?.some((tag) => tag.toLowerCase() === query)) return true;
    if (agent.SmartContractWallet?.walletAddress?.toLowerCase().includes(query)) return true;
    if (agent.RecipientWallet?.walletAddress?.toLowerCase().includes(query)) return true;
    if (agent.state?.toLowerCase().includes(query)) return true;
    if (pricing?.pricingType === 'Free' && 'free'.startsWith(query)) return true;
    if (pricing?.pricingType === 'Dynamic' && 'dynamic'.startsWith(query)) return true;
    if (
      amountRange &&
      pricing?.pricingType === 'Fixed' &&
      pricing.Pricing.some((p) => {
        const amt = parseAmountToBigInt(p.amount);
        return amt != null && amt >= amountRange.min && amt <= amountRange.max;
      })
    )
      return true;
    return false;
  });
}
