/**
 * The wallet pairs a head runs between, and the participants that stand for
 * them on each side.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { Client } from '@/lib/api/generated/client';
import { ensureData, fetchHydraPages } from './api';
import type { HydraWalletBaseResponse } from './api';
import type {
  HydraParticipant,
  HydraRelation,
  HydraRemoteParticipant,
  HydraWalletBase,
} from './types';

export function useHydraRelations(network?: 'Preprod' | 'Mainnet') {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraRelation[]>({
    queryKey: ['hydra-relations', network],
    queryFn: async () =>
      fetchHydraPages<HydraRelation>(apiClient, '/hydra/relation', 'relations', { network }),
    enabled: !!apiClient,
    staleTime: 10000,
  });

  return {
    ...query,
    relations: query.data ?? [],
  };
}

export function useHydraLocalParticipants(walletId?: string, hydraHostId?: string) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraParticipant[]>({
    queryKey: ['hydra-local-participants', walletId ?? 'any', hydraHostId ?? 'any'],
    queryFn: async () =>
      fetchHydraPages<HydraParticipant>(apiClient, '/hydra/participant/local', 'participants', {
        // Filtering by host wants every participant on it, assigned or not.
        ...(hydraHostId ? { hydraHostId } : { unassigned: true }),
        walletId,
      }),
    enabled: !!apiClient,
    staleTime: 10000,
  });

  return {
    ...query,
    participants: query.data ?? [],
  };
}

export function useHydraRemoteParticipants(walletId?: string) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraRemoteParticipant[]>({
    queryKey: ['hydra-remote-participants', walletId],
    queryFn: async () =>
      fetchHydraPages<HydraRemoteParticipant>(
        apiClient,
        '/hydra/participant/remote',
        'participants',
        {
          unassigned: true,
          walletId,
        },
      ),
    enabled: !!apiClient,
    staleTime: 10000,
  });

  return {
    ...query,
    participants: query.data ?? [],
  };
}

export function useHydraWalletBases(network?: 'Preprod' | 'Mainnet', paymentSourceId?: string) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraWalletBase[]>({
    queryKey: ['hydra-wallet-bases', network, paymentSourceId],
    queryFn: async () =>
      fetchHydraPages<HydraWalletBase>(apiClient, '/hydra/wallet-base', 'wallets', {
        network,
        paymentSourceId,
      }),
    enabled: !!apiClient,
    staleTime: 10000,
  });

  return {
    ...query,
    wallets: query.data ?? [],
  };
}

export async function ensureHydraWalletBaseForHotWallet(
  apiClient: Client,
  payload: { hotWalletId: string },
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraWalletBaseResponse>({
        responseType: 'json',
        url: '/hydra/wallet-base',
        body: payload,
      }),
    { errorMessage: 'Failed to prepare remote wallet' },
  );

  return ensureData(response?.data?.data, 'Remote wallet was not returned by the API');
}
