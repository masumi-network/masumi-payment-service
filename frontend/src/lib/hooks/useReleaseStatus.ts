/**
 * The release this service and each Hydra node run, against the newest
 * published release. The server asks GitHub at most every six hours, so a
 * long stale time here costs nothing.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { ReleaseWithUpdate } from '@/lib/release';

export type ReleaseStatus = {
  latest: { version: string; url: string; publishedAt: string | null } | null;
  checkedAt: string | null;
  checkError: string | null;
  service: ReleaseWithUpdate;
  /** Empty for a key without admin access. */
  hosts: Array<{ id: string; name: string; network: string; release: ReleaseWithUpdate }>;
};

type ReleaseStatusResponse = { 200: { status: string; data: ReleaseStatus } };

const RELEASE_STATUS_STALE_MS = 10 * 60 * 1000;

export function useReleaseStatus() {
  const { apiClient } = useAppContext();

  const query = useQuery<ReleaseStatus | null>({
    queryKey: ['release-status'],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          apiClient.get<ReleaseStatusResponse>({ responseType: 'json', url: '/release-status' }),
        // A version label must never raise an error toast over the page.
        { onError: () => undefined },
      );
      return response?.data?.data ?? null;
    },
    enabled: !!apiClient,
    staleTime: RELEASE_STATUS_STALE_MS,
  });

  return { releaseStatus: query.data ?? null, isLoading: query.isLoading };
}
