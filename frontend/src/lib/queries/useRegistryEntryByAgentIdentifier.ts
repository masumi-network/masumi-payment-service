import { useQuery } from '@tanstack/react-query';
import { getRegistry, RegistryEntry } from '@/lib/api/generated';
import { useAppContext, type NetworkType } from '@/lib/contexts/AppContext';

/**
 * Resolves a registry row visible to the current wallet scope for the given payment source.
 * Used to decide whether `agentIdentifier` can link to the AI Agents detail dialog.
 */
export function useRegistryEntryByAgentIdentifier(options: {
  agentIdentifier: string | null | undefined;
  smartContractAddress: string | null | undefined;
  /** When set (e.g. from a transaction’s PaymentSource), avoids mixing global UI network with row-specific SC/network. */
  network?: NetworkType | null | undefined;
  enabled?: boolean;
}) {
  const { apiClient, network: contextNetwork } = useAppContext();
  const { agentIdentifier, smartContractAddress, network: networkOption, enabled = true } = options;
  const network = networkOption ?? contextNetwork;

  return useQuery({
    queryKey: [
      'registry-entry-by-agent-identifier',
      network,
      smartContractAddress,
      agentIdentifier,
    ],
    queryFn: async (): Promise<RegistryEntry | null> => {
      if (!agentIdentifier || !smartContractAddress) return null;

      const response = await getRegistry({
        client: apiClient,
        query: {
          network,
          limit: 1,
          filterSmartContractAddress: smartContractAddress,
          filterAgentIdentifier: agentIdentifier,
        },
      });

      if (response.error) return null;

      const assets = response.data?.data?.Assets ?? [];
      const entry = assets[0];
      if (entry?.agentIdentifier === agentIdentifier) return entry;
      return null;
    },
    enabled: Boolean(enabled && agentIdentifier && smartContractAddress && network),
    staleTime: 60_000,
  });
}
