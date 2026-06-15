import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { agentMigrationKey, fetchAllRegistryEntries } from '@/lib/agent-migration';

/**
 * How many V1 (legacy) agents on the active network still have no V2 counterpart, used to
 * nudge the operator toward migration. Matches agents by metadata (agentMigrationKey),
 * since a migrated agent is a fresh V2 mint with a new identifier. Only runs when the
 * network actually has both a V1 and a V2 source (otherwise there's nothing to migrate).
 */
export function useMigrationStatus() {
  const { apiClient, authorized, network } = useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();

  const { v1Addresses, v2Addresses } = useMemo(() => {
    const onNetwork = paymentSources.filter((source) => source.network === network);
    return {
      v1Addresses: onNetwork
        .filter((s) => !isV2PaymentSource(s))
        .map((s) => s.smartContractAddress),
      v2Addresses: onNetwork.filter(isV2PaymentSource).map((s) => s.smartContractAddress),
    };
  }, [paymentSources, network]);

  const canMigrate = v1Addresses.length > 0 && v2Addresses.length > 0;

  const query = useQuery({
    queryKey: ['migration-status', network, [...v1Addresses].sort(), [...v2Addresses].sort()],
    queryFn: async () => {
      const [v1Lists, v2Lists] = await Promise.all([
        Promise.all(
          v1Addresses.map((smartContractAddress) =>
            fetchAllRegistryEntries({ apiClient, network, smartContractAddress }),
          ),
        ),
        Promise.all(
          v2Addresses.map((smartContractAddress) =>
            fetchAllRegistryEntries({ apiClient, network, smartContractAddress }),
          ),
        ),
      ]);
      const v2Keys = new Set(v2Lists.flat().map(agentMigrationKey));
      return v1Lists.flat().filter((agent) => !v2Keys.has(agentMigrationKey(agent))).length;
    },
    enabled: !!apiClient && authorized && canMigrate,
    staleTime: 60_000,
    // This fans out a fetch across every payment source just to render a one-line nudge,
    // so don't re-run it on every window refocus — the post-migration invalidation and the
    // staleTime keep the count fresh enough.
    refetchOnWindowFocus: false,
  });

  return {
    unmigratedCount: query.data ?? 0,
    canMigrate,
    isLoading: query.isLoading,
  };
}
