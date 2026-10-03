import type { X402PaymentFilters } from '@/lib/hooks/useX402';

export function buildX402TransactionScope(
  filters: X402PaymentFilters,
  activeCaip2Network: string | undefined,
): { filters: X402PaymentFilters; isEnabled: boolean } {
  return {
    filters: { ...filters, caip2Network: activeCaip2Network },
    isEnabled: !!activeCaip2Network,
  };
}
