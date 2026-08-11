/**
 * Connected Hydra nodes.
 *
 * A "node" here is a Hydra Host: one reverse-proxied control plane that
 * supervises a hydra-node process per head. The service holds two tokens for
 * it — an admin key that may provision and reconfigure, and a user key used at
 * runtime to reach the proxied node API — and neither is ever returned once
 * stored, so the UI can only ever report whether one is present.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { Client } from '@/lib/api/generated/client';

export type HydraHostStatus = 'Active' | 'Draining' | 'Disabled' | 'Unreachable';

export type HydraHost = {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  network: 'Preprod' | 'Mainnet';
  baseUrl: string;
  allowInsecureHttp: boolean;
  publicPeerHost: string;
  /** Presence only; the token itself is never returned by the API. */
  hasAdminToken: boolean;
  hydraVersion: string | null;
  scriptCatalogueHash: string | null;
  ledgerParamsHash: string | null;
  status: HydraHostStatus;
  lastHealthAt: string | null;
  lastHealthError: string | null;
  participantCount: number;
};

type ApiEnvelope<T> = { status: string; data: T };

type HydraHostsResponse = { 200: ApiEnvelope<{ hosts: HydraHost[] }> };
type HydraHostResponse = { 200: ApiEnvelope<HydraHost> };

export type ConnectHydraHostRequest = {
  name: string;
  network: 'Preprod' | 'Mainnet';
  baseUrl: string;
  allowInsecureHttp: boolean;
  /** Defaults to the hostname in baseUrl, which is right unless peers dial a different name. */
  publicPeerHost?: string;
  /** A lower-privilege runtime key. Omitted means the admin key is used for runtime calls too. */
  userToken?: string;
  /** Opens and runs heads. Required: without it no head can be opened on this node. */
  adminToken: string;
};

export type UpdateHydraHostRequest = {
  id: string;
  name?: string;
  status?: HydraHostStatus;
  allowInsecureHttp?: boolean;
  userToken?: string;
  /** Null clears the admin token, which disables provisioning on this node. */
  adminToken?: string | null;
};

function ensureData<T>(value: T | undefined | null, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

export function useHydraHosts(network?: 'Preprod' | 'Mainnet') {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraHost[]>({
    queryKey: ['hydra-hosts', network ?? 'all'],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          apiClient.get<HydraHostsResponse>({
            responseType: 'json',
            url: '/hydra/host',
            query: network ? { network } : {},
          }),
        {
          onError: (error: unknown) => {
            console.error('Failed to fetch Hydra hosts:', error);
          },
          errorMessage: 'Failed to load connected Hydra nodes',
        },
      );
      return response?.data?.data?.hosts ?? [];
    },
    enabled: !!apiClient,
    staleTime: 10000,
  });

  const hosts = useMemo(() => query.data ?? [], [query.data]);

  return {
    hosts,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

export async function connectHydraHost(apiClient: Client, payload: ConnectHydraHostRequest) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraHostResponse>({
        responseType: 'json',
        url: '/hydra/host',
        body: payload,
      }),
    { errorMessage: 'Failed to connect the Hydra node' },
  );

  return ensureData(response?.data?.data, 'The connected node was not returned by the API');
}

export async function updateHydraHost(apiClient: Client, payload: UpdateHydraHostRequest) {
  const response = await handleApiCall(
    () =>
      apiClient.patch<HydraHostResponse>({
        responseType: 'json',
        url: '/hydra/host',
        body: payload,
      }),
    { errorMessage: 'Failed to update the Hydra node' },
  );

  return ensureData(response?.data?.data, 'The updated node was not returned by the API');
}

export async function disconnectHydraHost(apiClient: Client, id: string) {
  await handleApiCall(
    () =>
      apiClient.delete<{ 200: ApiEnvelope<{ id: string }> }>({
        responseType: 'json',
        url: '/hydra/host',
        body: { id },
      }),
    { errorMessage: 'Failed to disconnect the Hydra node' },
  );
}

/**
 * Probe the node and record what it reports.
 *
 * A failed probe marks it Unreachable, which stops new head placements but
 * never disturbs heads already on it — a head cannot be moved between nodes.
 */
export async function checkHydraHost(apiClient: Client, id: string) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraHostResponse>({
        responseType: 'json',
        url: '/hydra/host/check',
        body: { id },
      }),
    { errorMessage: 'Failed to check the Hydra node' },
  );

  return ensureData(response?.data?.data, 'The node check result was not returned by the API');
}
