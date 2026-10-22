/**
 * Pending L2 reservations on a head, and the admin release for an expired one
 * that no proof can free.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { Client } from '@/lib/api/generated/client';
import { ensureData } from './api';
import type { ApiEnvelope } from './api';

export type HydraL2Reservation = {
  transactionId: string;
  /** Sent back on release. The server refuses it if the row changed. */
  updatedAt: string;
  intendedTxHash: string | null;
  expiresAt: string | null;
  kind: 'initial-lock' | 'action';
  purchaseRequestIds: string[];
  paymentRequestIds: string[];
  walletAddress: string | null;
  inputRefs: string[];
  /** From our node's reference map: a hint, never evidence. */
  inputsReportedUnspent: number | null;
  releaseNudgeTxHash: string | null;
  rejectedByHeadReason: string | null;
  releasable: boolean;
  blockedReason: string | null;
};

export type HydraL2ReservationRelease = {
  transactionId: string;
  purchaseRequestIds: string[];
  paymentRequestIds: string[];
};

/** Recovery runs about once a minute, so polling faster shows nothing new. */
const L2_RESERVATIONS_POLL_MS = 60_000;

/** Read quietly, and throw on failure so a lost poll keeps the last list. */
export async function fetchHydraL2Reservations(
  apiClient: Client,
  headId: string,
): Promise<HydraL2Reservation[]> {
  const response = await handleApiCall(
    () =>
      apiClient.get<{ 200: ApiEnvelope<{ headId: string; reservations: HydraL2Reservation[] }> }>({
        responseType: 'json',
        url: '/hydra/head/l2-reservations',
        query: { headId },
      }),
    {
      onError: (error: unknown) => {
        console.error('Failed to read the Hydra L2 reservations:', error);
      },
    },
  );
  if (response?.data?.data == null) {
    throw new Error('Failed to read the Hydra L2 reservations');
  }
  return response.data.data.reservations;
}

export function useHydraL2Reservations(headId: string | null, isOpen: boolean) {
  const { apiClient } = useAppContext();

  return useQuery<HydraL2Reservation[]>({
    queryKey: ['hydra-l2-reservations', headId],
    queryFn: async () => (headId ? fetchHydraL2Reservations(apiClient, headId) : []),
    enabled: !!apiClient && !!headId && isOpen,
    staleTime: L2_RESERVATIONS_POLL_MS / 2,
    refetchInterval: L2_RESERVATIONS_POLL_MS,
  });
}

export async function releaseHydraL2Reservation(
  apiClient: Client,
  payload: { headId: string; transactionId: string; expectedUpdatedAt: string },
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{ 200: ApiEnvelope<HydraL2ReservationRelease> }>({
        responseType: 'json',
        url: '/hydra/head/l2-reservations/release',
        body: { ...payload, acknowledgeUnprovable: true },
      }),
    { errorMessage: 'Failed to release the L2 reservation' },
  );

  return ensureData(response?.data?.data, 'The release response was not returned by the API');
}

/** A released reservation whose body confirmed anyway, holding the head's replay. */
export type HydraStalledRelease = {
  transactionId: string;
  /** Sent back on re-apply. The server refuses it if the row changed. */
  updatedAt: string;
  intendedTxHash: string;
  releasedBy: 'input-proof' | 'operator';
  releasedAt: string;
  kind: 'initial-lock' | 'action';
  purchaseRequestIds: string[];
  paymentRequestIds: string[];
  reapplicable: boolean;
  blockedReason: string | null;
};

export async function fetchHydraStalledRelease(
  apiClient: Client,
  headId: string,
): Promise<HydraStalledRelease | null> {
  const response = await handleApiCall(
    () =>
      apiClient.get<{
        200: ApiEnvelope<{ headId: string; reservation: HydraStalledRelease | null }>;
      }>({
        responseType: 'json',
        url: '/hydra/head/l2-reservations/stalled-release',
        query: { headId },
      }),
    {
      onError: (error: unknown) => {
        console.error('Failed to read the stalled Hydra release:', error);
      },
    },
  );
  if (response?.data?.data == null) {
    throw new Error('Failed to read the stalled Hydra release');
  }
  return response.data.data.reservation;
}

/** Read only while the head's replay is held on a confirmed body. */
export function useHydraStalledRelease(headId: string, isHeld: boolean) {
  const { apiClient } = useAppContext();

  return useQuery<HydraStalledRelease | null>({
    queryKey: ['hydra-stalled-release', headId],
    queryFn: async () => fetchHydraStalledRelease(apiClient, headId),
    enabled: !!apiClient && isHeld,
    staleTime: L2_RESERVATIONS_POLL_MS / 2,
    refetchInterval: L2_RESERVATIONS_POLL_MS,
  });
}

export async function reapplyHydraL2Reservation(
  apiClient: Client,
  payload: { headId: string; transactionId: string; expectedUpdatedAt: string },
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{ 200: ApiEnvelope<HydraL2ReservationRelease> }>({
        responseType: 'json',
        url: '/hydra/head/l2-reservations/reapply',
        body: payload,
      }),
    { errorMessage: 'Failed to re-apply the L2 reservation' },
  );

  return ensureData(response?.data?.data, 'The re-apply response was not returned by the API');
}
