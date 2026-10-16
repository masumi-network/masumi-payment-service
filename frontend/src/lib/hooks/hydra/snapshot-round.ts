/**
 * The head's snapshot round, as our node reports it, and the admin reset for a
 * round that has stopped moving.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { Client } from '@/lib/api/generated/client';
import { ensureData } from './api';
import type { ApiEnvelope } from './api';

export type HydraSnapshotRound = {
  headId: string;
  inFlight: boolean;
  tag: string;
  snapshotNumber: number | null;
  signatoryCount: number;
  txIds: string[];
  /** Identifies this exact round. The reset sends it back unchanged. */
  signature: string;
  since: string | null;
  stuck: boolean;
};

export type HydraSnapshotRoundReset = {
  headId: string;
  confirmedSnapshotNumber: number;
  droppedTxIds: string[];
  roundAfter: { tag: string; snapshotNumber: number | null } | null;
};

/** The watch job records a round once a minute, so polling faster shows nothing new. */
const SNAPSHOT_ROUND_POLL_MS = 60_000;

/**
 * Read quietly. The server refuses the read while this instance holds no
 * session for the head, and a toast every minute for that says nothing useful.
 */
export async function fetchHydraSnapshotRound(
  apiClient: Client,
  headId: string,
): Promise<HydraSnapshotRound | null> {
  const response = await handleApiCall(
    () =>
      apiClient.get<{ 200: ApiEnvelope<HydraSnapshotRound> }>({
        responseType: 'json',
        url: '/hydra/head/snapshot-round',
        query: { headId },
      }),
    {
      onError: (error: unknown) => {
        console.error('Failed to read the Hydra snapshot round:', error);
      },
    },
  );
  return response?.data?.data ?? null;
}

export function useHydraSnapshotRound(headId: string | null, isOpen: boolean) {
  const { apiClient } = useAppContext();

  return useQuery<HydraSnapshotRound | null>({
    queryKey: ['hydra-snapshot-round', headId],
    queryFn: async () => (headId ? fetchHydraSnapshotRound(apiClient, headId) : null),
    enabled: !!apiClient && !!headId && isOpen,
    staleTime: SNAPSHOT_ROUND_POLL_MS / 2,
    refetchInterval: SNAPSHOT_ROUND_POLL_MS,
  });
}

export async function resetHydraSnapshotRound(
  apiClient: Client,
  payload: { headId: string; expectedSignature: string },
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{ 200: ApiEnvelope<HydraSnapshotRoundReset> }>({
        responseType: 'json',
        url: '/hydra/head/snapshot-round/reset',
        body: payload,
      }),
    { errorMessage: 'Failed to reset the snapshot round' },
  );

  return ensureData(response?.data?.data, 'The reset response was not returned by the API');
}
