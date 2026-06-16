import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRegistry, RegistryEntry } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useX402Networks } from '@/lib/hooks/useX402';
import { chainsForEnv } from '@/lib/x402-rail';
import { handleApiCall } from '@/lib/utils';
import { appendInclusiveCursorPage } from '@/lib/pagination/cursor-pagination';

const PAGE_SIZE = 50;
// Safety bound so a paging bug can never loop forever; far above any realistic agent count.
const MAX_PAGES = 50;

/**
 * How an agent relates to the currently-viewed payment source / chain:
 * - `registered`: the agent's registry entry lives on this Cardano source.
 * - `payment`: the agent is registered elsewhere but advertises this source/chain as a
 *   supported payment target (a Cardano source it accepts, or an EVM chain over x402).
 */
export type AgentRelation = 'registered' | 'payment';
export type AgentWithRelation = RegistryEntry & { relation: AgentRelation };

type AgentQuery = {
  filterStatus?: 'Registered' | 'Deregistered' | 'Pending' | 'Failed';
  searchQuery?: string;
  filterSmartContractAddress?: string;
  // Server-side "advertises this payment source" filters. Either matches an
  // entry's supportedPaymentSources so the payment-target list no longer pages
  // every agent on the network and filters client-side.
  filterSupportedPaymentSourceAddress?: string;
  filterSupportedPaymentSourceNetworks?: string;
};

async function fetchAllAgents(
  apiClient: ReturnType<typeof useAppContext>['apiClient'],
  network: 'Preprod' | 'Mainnet',
  extra: AgentQuery,
): Promise<{ items: RegistryEntry[]; truncated: boolean }> {
  let items: RegistryEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await handleApiCall(
      () =>
        getRegistry({
          client: apiClient,
          query: {
            network,
            cursorId: cursor,
            limit: PAGE_SIZE,
            filterStatus: extra.filterStatus,
            searchQuery: extra.searchQuery || undefined,
            filterSmartContractAddress: extra.filterSmartContractAddress,
            filterSupportedPaymentSourceAddress: extra.filterSupportedPaymentSourceAddress,
            filterSupportedPaymentSourceNetworks: extra.filterSupportedPaymentSourceNetworks,
          },
        }),
      { errorMessage: 'Failed to load AI agents' },
    );
    const batch = (response?.data?.data?.Assets ?? []) as RegistryEntry[];
    // The Prisma cursor is inclusive, so each page after the first repeats the previous
    // page's last row. Dedup by id while accumulating; cursor/length checks below still
    // use the raw `batch` so end-of-list detection is unaffected.
    items = appendInclusiveCursorPage(items, batch, (agent) => agent.id);
    // A short page means the cursor is fully drained — everything loaded.
    if (batch.length < PAGE_SIZE) return { items, truncated: false };
    const last = batch[batch.length - 1];
    if (!last?.id || last.id === cursor) return { items, truncated: false };
    cursor = last.id;
  }
  // Exhausted MAX_PAGES with every page full: more entries almost certainly remain.
  return { items, truncated: true };
}

/**
 * Rail-aware agent list for the AI Agents page. Agents are always registered on Cardano,
 * but a single entry can also declare payment targets on other sources and on EVM chains
 * (x402). This surfaces both relationships for the active context:
 *
 * - Cardano rail: agents registered on the selected source, plus agents registered
 *   elsewhere that accept payment on it.
 * - x402 rail: agents that accept x402 payment on a chain in the active environment.
 *
 * "registered" is taken from the source-filtered query (which includes legacy entries
 * whose `supportedPaymentSources` is null); "payment" is matched from that field.
 */
export function useContextAgents(params?: {
  filterStatus?: 'Registered' | 'Deregistered' | 'Pending' | 'Failed';
  searchQuery?: string;
}) {
  const { apiClient, authorized, network, activeRail, selectedPaymentSource } = useAppContext();
  const { networks } = useX402Networks({ silentErrors: true });

  const envChainIds = useMemo(
    () => new Set(chainsForEnv(networks, network).map((chain) => chain.caip2Id)),
    [networks, network],
  );

  const sourceAddress =
    selectedPaymentSource?.network === network ? selectedPaymentSource.smartContractAddress : null;

  // CAIP-2 ids of the EVM chains active in this environment, as the comma-separated
  // value the registry endpoint's filterSupportedPaymentSourceNetworks expects.
  const envChainIdsCsv = useMemo(() => [...envChainIds].join(','), [envChainIds]);

  // Agents that accept payment on THIS context as a payment target (regardless of where
  // they are registered). Previously this paged every agent on the network and matched
  // `supportedPaymentSources` client-side; now the registry endpoint filters by the
  // selected source address (Cardano) or active EVM chain ids (x402) server-side.
  // Disabled until we have something to scope by, so we never fetch the whole network.
  const paymentScope: Pick<
    AgentQuery,
    'filterSupportedPaymentSourceAddress' | 'filterSupportedPaymentSourceNetworks'
  > =
    activeRail === 'x402'
      ? { filterSupportedPaymentSourceNetworks: envChainIdsCsv || undefined }
      : { filterSupportedPaymentSourceAddress: sourceAddress ?? undefined };
  const hasPaymentScope = activeRail === 'x402' ? !!envChainIdsCsv : !!sourceAddress;

  const allQuery = useQuery({
    queryKey: [
      'context-agents',
      'payment',
      network,
      activeRail,
      activeRail === 'x402' ? envChainIdsCsv : sourceAddress,
      params?.filterStatus,
      params?.searchQuery,
    ],
    queryFn: () =>
      fetchAllAgents(apiClient, network, {
        filterStatus: params?.filterStatus,
        searchQuery: params?.searchQuery,
        ...paymentScope,
      }),
    enabled: !!apiClient && authorized && hasPaymentScope,
    staleTime: 15000,
    // Keep showing the previous results while a status/search change refetches, so the
    // table can dim (isPlaceholderData) rather than flashing empty mid-search.
    placeholderData: keepPreviousData,
  });

  // Agents registered on the selected Cardano source. Only needed on the Cardano rail, and
  // the authoritative source of the "registered" set (covers legacy null-metadata entries).
  const registeredQuery = useQuery({
    queryKey: [
      'context-agents',
      'registered',
      network,
      sourceAddress,
      params?.filterStatus,
      params?.searchQuery,
    ],
    queryFn: () =>
      fetchAllAgents(apiClient, network, {
        filterSmartContractAddress: sourceAddress ?? undefined,
        filterStatus: params?.filterStatus,
        searchQuery: params?.searchQuery,
      }),
    enabled: !!apiClient && authorized && activeRail === 'cardano' && !!sourceAddress,
    staleTime: 15000,
    placeholderData: keepPreviousData,
  });

  const agents = useMemo<AgentWithRelation[]>(() => {
    const all = allQuery.data?.items ?? [];

    if (activeRail === 'x402') {
      // Registration never happens on EVM, so every match is a payment target.
      return all
        .filter((agent) =>
          (agent.supportedPaymentSources ?? []).some(
            (source) => source.chain === 'EVM' && envChainIds.has(source.network),
          ),
        )
        .map((agent) => ({ ...agent, relation: 'payment' as const }));
    }

    if (!sourceAddress) return [];
    // Wait for the authoritative registered set before merging. If we built the list with
    // an empty registered set while registeredQuery is still loading, an agent registered
    // on this source that also lists it in supportedPaymentSources would be mislabeled
    // "payment accepted" (hiding verify/update/delete) until the second query resolves.
    // Returning [] keeps the page in its loading state (see isLoading below) until then.
    if (registeredQuery.data === undefined) return [];
    // Build from the source-scoped registered set (authoritative and complete for this
    // source) so a registered agent is never dropped just because it fell outside the
    // page-capped network-wide `all` set. Then append agents registered elsewhere that
    // accept payment on this source, deduped against the registered ones.
    const registered = registeredQuery.data.items;
    const registeredIds = new Set(registered.map((agent) => agent.id));
    const paymentAccepted = all.filter(
      (agent) =>
        !registeredIds.has(agent.id) &&
        (agent.supportedPaymentSources ?? []).some(
          (source) => source.chain === 'Cardano' && source.address === sourceAddress,
        ),
    );
    return [
      ...registered.map((agent) => ({ ...agent, relation: 'registered' as const })),
      ...paymentAccepted.map((agent) => ({ ...agent, relation: 'payment' as const })),
    ];
  }, [allQuery.data, registeredQuery.data, activeRail, envChainIds, sourceAddress]);

  const isRegisteredQueryActive = activeRail === 'cardano' && !!sourceAddress;
  // The registered set is authoritative for the 'registered' label, and the merged list is
  // withheld (above) until it resolves. Treat that window as loading so the page shows a
  // skeleton instead of an empty state or a half-labeled list.
  const registeredPending = isRegisteredQueryActive && registeredQuery.data === undefined;

  // The list is fetched in full but bounded by fetchAllAgents' page cap. Surface when that
  // cap was hit so the page can warn the operator instead of silently showing a partial set.
  const truncated =
    (allQuery.data?.truncated ?? false) ||
    (isRegisteredQueryActive && (registeredQuery.data?.truncated ?? false));

  // True while showing the previous results during a status/search change (keepPreviousData),
  // so the page can dim the table and run its instant client-side search filter.
  const isPlaceholderData =
    allQuery.isPlaceholderData || (isRegisteredQueryActive && registeredQuery.isPlaceholderData);

  return {
    agents,
    truncated,
    isPlaceholderData,
    isLoading: allQuery.isLoading || registeredPending,
    isFetching: allQuery.isFetching || (isRegisteredQueryActive && registeredQuery.isFetching),
    refetch: async () => {
      await Promise.all([
        allQuery.refetch(),
        isRegisteredQueryActive ? registeredQuery.refetch() : Promise.resolve(),
      ]);
    },
  };
}
