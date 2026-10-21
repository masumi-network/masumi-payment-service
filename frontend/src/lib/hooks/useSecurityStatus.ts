/**
 * Insecure service configuration, as reported to admin keys. The answer only
 * changes when the service restarts, so it is fetched once per page load.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';

export type SecurityStatus = { isEncryptionKeyPublic: boolean };

type SecurityStatusResponse = { 200: { status: string; data: SecurityStatus } };

export function useSecurityStatus() {
  const { apiClient, capabilities } = useAppContext();

  const query = useQuery<SecurityStatus | null>({
    queryKey: ['security-status'],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          apiClient.get<SecurityStatusResponse>({ responseType: 'json', url: '/security-status' }),
        // A failed check shows no banner; it must not raise an error toast over every page.
        { onError: () => undefined },
      );
      return response?.data?.data ?? null;
    },
    // The endpoint is admin only.
    enabled: !!apiClient && capabilities.canAdmin,
    staleTime: Infinity,
  });

  return { securityStatus: query.data ?? null };
}
