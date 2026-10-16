/**
 * Pausing a Hydra node for maintenance, such as an upgrade.
 *
 * The server owns the pause and moves it forward on its own, so this only
 * reads the phase and sends the two commands. It polls while a pause is in
 * progress, because the phase changes without any action here.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { Client } from '@/lib/api/generated/client';

export type HydraHostPausePhase = 'Active' | 'Draining' | 'Stopping' | 'Paused';

export type HydraHostPauseState = {
  hostId: string;
  phase: HydraHostPausePhase;
  pausedAt: string | null;
  pauseStopRequestedAt: string | null;
  inFlight: { l2Transactions: number; topups: number; withdrawals: number; closingHeads: number };
  nodes: Array<{ nodeId: string; state: string | null; error: string | null }>;
};

type PauseStateResponse = { 200: { status: string; data: HydraHostPauseState } };

const PAUSE_POLL_MS = 5000;

/** `isPaused` comes from the host list, so polling starts even when the first read fails. */
export function useHydraHostPause(hostId: string | null, isPaused: boolean) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraHostPauseState>({
    queryKey: ['hydra-host-pause', hostId],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          apiClient.get<PauseStateResponse>({
            responseType: 'json',
            url: '/hydra/host/pause',
            query: { id: hostId },
          }),
        // Polled every few seconds, so a failure must not toast each time.
        { onError: () => undefined },
      );
      // Thrown, not returned as null: a null success would replace the last
      // known phase and stop the polling for good after one failed request.
      const state = response?.data?.data;
      if (!state) throw new Error('Failed to read the pause state');
      return state;
    },
    enabled: !!apiClient && hostId !== null,
    refetchInterval: (current) => {
      const phase = current.state.data?.phase;
      if (phase === undefined) return isPaused ? PAUSE_POLL_MS : false;
      return phase === 'Active' || phase === 'Paused' ? false : PAUSE_POLL_MS;
    },
  });

  return { pauseState: query.data ?? null, refetch: query.refetch };
}

async function sendPauseCommand(
  apiClient: Client,
  url: '/hydra/host/pause' | '/hydra/host/resume',
  body: { id: string; force?: boolean },
  errorMessage: string,
): Promise<HydraHostPauseState> {
  const response = await handleApiCall(
    () => apiClient.post<PauseStateResponse>({ responseType: 'json', url, body }),
    { errorMessage },
  );
  const state = response?.data?.data;
  // `handleApiCall` reports a refusal by returning nothing; say so instead of
  // letting the caller show a success.
  if (!state) throw new Error(errorMessage);
  return state;
}

export function pauseHydraHost(apiClient: Client, id: string, force: boolean) {
  return sendPauseCommand(apiClient, '/hydra/host/pause', { id, force }, 'The node was not paused');
}

export function resumeHydraHost(apiClient: Client, id: string) {
  return sendPauseCommand(apiClient, '/hydra/host/resume', { id }, 'The node was not resumed');
}
