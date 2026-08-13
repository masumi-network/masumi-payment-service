/**
 * Invites: minting one, reading one that arrived, and taking it up.
 *
 * An invite is a head with one participant missing, which is why it lives
 * beside the head hooks rather than in a module of its own concept.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { Client } from '@/lib/api/generated/client';
import { ensureData } from './api';
import type { ApiEnvelope } from './api';
import type { HydraInvite, HydraInvitePreview, HydraNodeKeys } from './types';

/** Invites on one network, scoped like the heads they become. */
export function useHydraInvites(network?: string) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraInvite[]>({
    queryKey: ['hydra-invites', network ?? 'all'],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          apiClient.get<{ 200: ApiEnvelope<{ invites: HydraInvite[] }> }>({
            responseType: 'json',
            url: '/hydra/invite',
            query: { limit: 100, ...(network ? { network } : {}) },
          }),
        { errorMessage: 'Failed to load Hydra invites' },
      );
      return response?.data?.data?.invites ?? [];
    },
    enabled: !!apiClient,
    staleTime: 10000,
  });

  return { ...query, invites: query.data ?? [] };
}

/**
 * Mint an invite.
 *
 * Reserves a node and a peer port on a Hydra Host and signs their material with
 * the chosen wallet. The reservation is held until someone redeems the invite,
 * it is revoked, or it expires, a node cannot be re-pointed at a different
 * counterparty once issued.
 */
export async function createHydraInvite(
  apiClient: Client,
  payload: {
    hotWalletId: string;
    ttlHours?: number;
    depositPeriodSeconds?: number;
    contestationPeriodSeconds?: number;
    unsyncedPeriodSeconds?: number;
  },
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{
        200: ApiEnvelope<{ id: string; nonce: string; expiresAt: string; code: string }>;
      }>({
        responseType: 'json',
        url: '/hydra/invite',
        body: payload,
      }),
    { errorMessage: 'Failed to create the invite' },
  );

  return ensureData(response?.data?.data, 'The invite was not returned by the API');
}

/**
 * Inspect an invite without acting on it.
 *
 * Nothing is provisioned and no counterparty is contacted, so this is safe to
 * call on an invite of unknown provenance, which is the point: the operator
 * sees who signed it before anything is spent.
 */
export async function previewHydraInvite(apiClient: Client, payload: { code: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{ 200: ApiEnvelope<HydraInvitePreview> }>({
        responseType: 'json',
        url: '/hydra/invite/preview',
        body: payload,
      }),
    { errorMessage: 'Failed to read the invite' },
  );

  return ensureData(response?.data?.data, 'The invite contents were not returned by the API');
}

/** Accept an invite: provisions our node, answers the issuer, records the head. */
export async function redeemHydraInvite(
  apiClient: Client,
  payload: {
    code: string;
    hotWalletId: string;
    allowInsecureExchangeHttp: boolean;
    allowPrivateExchangeNetwork: boolean;
  },
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{
        200: ApiEnvelope<{ id: string; hydraHeadId: string; counterpartyWalletAddress: string }>;
      }>({
        responseType: 'json',
        url: '/hydra/invite/redeem',
        body: payload,
      }),
    { errorMessage: 'Failed to redeem the invite' },
  );

  return ensureData(response?.data?.data, 'The redemption result was not returned by the API');
}

/** Withdraw an invite nobody has redeemed, releasing its node and peer port. */
export async function revokeHydraInvite(apiClient: Client, payload: { id: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.delete<{ 200: ApiEnvelope<{ id: string; status: string }> }>({
        responseType: 'json',
        url: '/hydra/invite',
        body: payload,
      }),
    { errorMessage: 'Failed to revoke the invite' },
  );

  return ensureData(response?.data?.data, 'The invite was not returned by the API');
}

/**
 * Take the one-time backup of a node's signing keys.
 *
 * The Hydra Host generates these and hands them over exactly once, at
 * provisioning; this service holds the only other copy. This call is therefore
 * also once-only, it seals itself server-side, so whatever comes back has to
 * be saved now or recovered from the Host.
 */
export async function revealHydraNodeKeys(apiClient: Client, payload: { id: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{ 200: ApiEnvelope<HydraNodeKeys> }>({
        responseType: 'json',
        url: '/hydra/participant/local/keys',
        body: payload,
      }),
    { errorMessage: 'Failed to read the node keys' },
  );

  return ensureData(response?.data?.data, 'The node keys were not returned by the API');
}
