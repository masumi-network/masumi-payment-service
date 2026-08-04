import type { GetRegistryData, PaymentSourceExtended, RegistryEntry } from '@/lib/api/generated';
import { appendInclusiveCursorPage } from '@/lib/pagination/cursor-pagination';

export type AgentListFilters = {
  filterStatus?: 'Registered' | 'Deregistered' | 'Pending' | 'Failed';
  searchQuery?: string;
};

export type AgentListSource = Pick<
  PaymentSourceExtended,
  'id' | 'network' | 'paymentSourceType' | 'smartContractAddress'
>;

export function resolveAgentListSource(
  selectedPaymentSourceId: string | null,
  selectedPaymentSource: PaymentSourceExtended | null,
  network: 'Preprod' | 'Mainnet',
): AgentListSource | null {
  if (
    selectedPaymentSourceId == null ||
    selectedPaymentSource == null ||
    selectedPaymentSource.id !== selectedPaymentSourceId ||
    selectedPaymentSource.network !== network
  ) {
    return null;
  }

  return selectedPaymentSource;
}

export function buildAgentListQuery(
  source: AgentListSource,
  filters: AgentListFilters,
  limit: number,
  cursor?: string,
): GetRegistryData['query'] {
  return {
    network: source.network,
    cursorId: cursor,
    limit,
    filterSmartContractAddress: source.smartContractAddress,
    // Address is unique today, but the explicit type is an intentional
    // compatibility boundary: a V1 tool must never accept V2 rows (or vice versa).
    filterPaymentSourceType: source.paymentSourceType,
    filterStatus: filters.filterStatus,
    searchQuery: filters.searchQuery || undefined,
  };
}

export async function collectAllAgentPages(
  fetchPage: (cursor?: string) => Promise<RegistryEntry[]>,
  pageSize: number,
): Promise<RegistryEntry[]> {
  let agents: RegistryEntry[] = [];
  let cursor: string | undefined;

  while (true) {
    const page = await fetchPage(cursor);
    if (page.length === 0) break;

    agents = appendInclusiveCursorPage(agents, page, (agent) => agent.id);

    const lastAgent = page[page.length - 1];
    if (page.length < pageSize || !lastAgent?.id || lastAgent.id === cursor) break;
    cursor = lastAgent.id;
  }

  return agents;
}
