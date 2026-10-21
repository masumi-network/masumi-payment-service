/**
 * Insecure service configuration, as reported to admin keys. The answer only
 * changes when the service restarts, so it is fetched once per page load.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getSecurityStatus } from '@/lib/api/generated';

export function useSecurityStatus() {
  const { apiClient, capabilities } = useAppContext();

  const query = useQuery({
    queryKey: ['security-status'],
    queryFn: async () => {
      const response = await getSecurityStatus({ client: apiClient });
      // Throw so a failed check is retried and not cached as "no warning". An empty
      // error body (a bare 502) is falsy, so check for the data too.
      const status = response.data?.data;
      if (response.error || !status) {
        throw new Error('Security status check failed');
      }
      return status;
    },
    // The endpoint is admin only.
    enabled: !!apiClient && capabilities.canAdmin,
    staleTime: Infinity,
  });

  return { securityStatus: query.data ?? null };
}
