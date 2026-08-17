/**
 * The heads themselves: reading them, watching them, and moving them through
 * their lifecycle.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import { extractApiErrorMessage } from '@/lib/api-error';
import type { Client } from '@/lib/api/generated/client';
import { ensureData, fetchHydraPages } from './api';
import type { ApiEnvelope, HydraHeadCommitResponse, HydraHeadLifecycleResponse } from './api';
import type {
  HydraHead,
  HydraHeadConnection,
  HydraHeadError,
  HydraHeadStatus,
  HydraHeadTransaction,
} from './types';

/**
 * Head states that are waiting on the chain rather than on the operator.
 *
 * A head sits in one of these for a block or two after an action, and the
 * action's own request does not carry the result, the status arrives from
 * frames the node pushes. Without polling, an operator who opened a head saw
 * Idle until they reloaded, which reads as "nothing happened".
 */
const SETTLING_STATUSES: HydraHeadStatus[] = ['Initializing', 'Connecting', 'Closed'];

/**
 * The heads this service runs, on one network.
 *
 * Scoped like the node strip beside it. A head belongs to one network for its
 * whole life, and an unscoped list put mainnet heads in a preprod view with
 * their node column blank and their transaction links pointed at the wrong
 * explorer. Undefined asks for every network, which is what a caller with no
 * network selected yet wants.
 */
export function useHydraHeads(network?: string) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraHead[]>({
    queryKey: ['hydra-heads', network ?? 'all'],
    queryFn: async () => {
      return fetchHydraPages<HydraHead>(
        apiClient,
        '/hydra/head',
        'heads',
        network ? { network } : undefined,
      );
    },
    enabled: !!apiClient,
    staleTime: 10000,
    // Only while something is actually moving. A steady list of Open heads does
    // not need a request every few seconds, and each one is a database round
    // trip per head.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((head) => SETTLING_STATUSES.includes(head.status))
        ? 5000
        : false,
  });

  const heads = useMemo(() => query.data ?? [], [query.data]);

  return {
    ...query,
    heads,
    isLoading: query.isLoading,
  };
}

/**
 * What went wrong on a head, so the count in the table leads somewhere.
 *
 * The endpoint existed from the start and nothing called it: the table said
 * "2 errors" and the detail view showed none of them, which is worse than not
 * counting at all.
 */
export function useHydraHeadErrors(headId: string | null) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraHeadError[]>({
    queryKey: ['hydra-head-errors', headId],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          apiClient.get<{ 200: ApiEnvelope<{ errors: HydraHeadError[] }> }>({
            responseType: 'json',
            url: '/hydra/head/errors',
            query: { headId, limit: 25 },
          }),
        { errorMessage: 'Failed to load the head errors' },
      );
      if (response?.data?.data?.errors == null) {
        throw new Error('Failed to load the head errors');
      }
      return response.data.data.errors;
    },
    enabled: !!apiClient && headId !== null,
    staleTime: 10000,
  });

  return { ...query, errors: query.data ?? [] };
}

/** Statuses that will not change again without something new happening. */
const SETTLED_TX_STATUSES = ['Confirmed', 'FailedViaTimeout', 'RolledBack'];

export function useHydraHeadTransactions(headId: string | null) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraHeadTransaction[]>({
    queryKey: ['hydra-head-transactions', headId],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          apiClient.get<{ 200: ApiEnvelope<{ transactions: HydraHeadTransaction[] }> }>({
            responseType: 'json',
            url: '/hydra/head/transactions',
            query: { headId, limit: 25 },
          }),
        { errorMessage: 'Could not load this head\u2019s transactions' },
      );
      if (response?.data?.data?.transactions == null) {
        throw new Error('Could not load this head\u2019s transactions');
      }
      return response.data.data.transactions;
    },
    enabled: !!apiClient && headId !== null,
    staleTime: 5000,
    // Follow anything still in flight to its end, then stop.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((tx) => !SETTLED_TX_STATUSES.includes(tx.status))
        ? 8000
        : false,
  });

  return { ...query, transactions: query.data ?? [] };
}

/**
 * Keep a head's node readiness fresh enough to gate its controls on.
 *
 * The Connection panel asks on demand, which is right for a diagnosis but wrong
 * for a button: an action offered against a node that is still catching up is
 * refused by the API, and the operator learns the state from the failure rather
 * than from the control. Polled only while the node is NOT ready, so a healthy
 * head costs one request.
 */
export function useHydraHeadReadiness(headId: string | null, enabled: boolean) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraHeadConnection | null>({
    queryKey: ['hydra-head-connection', headId],
    queryFn: async () => {
      if (headId === null) return null;
      return await readHydraHeadConnection(apiClient, { headId });
    },
    enabled: !!apiClient && headId !== null && enabled,
    staleTime: 5000,
    refetchInterval: (query) => (query.state.data?.isReady === true ? false : 10_000),
  });

  return { connection: query.data ?? null, ...query };
}

/** Whether the head's node is up and this service holds a live session to it. */
export async function readHydraHeadConnection(apiClient: Client, payload: { headId: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.get<{ 200: ApiEnvelope<HydraHeadConnection> }>({
        responseType: 'json',
        url: '/hydra/head/connection',
        query: payload,
      }),
    { errorMessage: 'Failed to check the connection' },
  );

  return ensureData(response?.data?.data, 'The connection state was not returned by the API');
}

/** Forget a head's errors. They are a log, so clearing them changes nothing but the display. */
export async function clearHydraHeadErrors(apiClient: Client, payload: { headId: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.delete<{ 200: ApiEnvelope<{ cleared: number }> }>({
        responseType: 'json',
        url: '/hydra/head/errors',
        body: payload,
      }),
    { errorMessage: 'Failed to clear the errors' },
  );

  return ensureData(response?.data?.data, 'The result was not returned by the API');
}

export async function initHydraHead(apiClient: Client, payload: { headId: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraHeadLifecycleResponse>({
        responseType: 'json',
        url: '/hydra/head/init',
        body: payload,
      }),
    { errorMessage: 'Failed to initialize Hydra head' },
  );

  return ensureData(response?.data?.data, 'Hydra head init response was not returned by the API');
}

export async function commitHydraHead(apiClient: Client, payload: { headId: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraHeadCommitResponse>({
        responseType: 'json',
        url: '/hydra/head/commit',
        body: payload,
      }),
    { errorMessage: 'Failed to commit local Hydra participant' },
  );

  return ensureData(response?.data?.data, 'Hydra head commit response was not returned by the API');
}

export async function closeHydraHead(
  apiClient: Client,
  payload: {
    headId: string;
    /**
     * Close even though the head still holds escrows or unconfirmed work.
     *
     * They are fanned out to L1 and collected there against the same datums
     * and deadlines. Refused without this, so it is never the accident.
     */
    acknowledgeActiveEscrows?: boolean;
  },
) {
  // Throws instead of toasting, unlike its siblings. The refusal this endpoint
  // gives for a head that still holds escrows is not a dead end — it is the
  // question the operator has to answer — so the caller needs the message rather
  // than the user needing a toast. `onError` suppresses the default toast; the
  // caller owns what happens next, including reporting a real failure.
  let apiError: unknown = null;
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraHeadLifecycleResponse>({
        responseType: 'json',
        url: '/hydra/head/close',
        body: payload,
      }),
    {
      errorMessage: 'Failed to close Hydra head',
      onError: (error: unknown) => {
        apiError = error;
      },
    },
  );
  if (apiError !== null) {
    throw new Error(extractApiErrorMessage(apiError, 'Failed to close Hydra head'));
  }

  return ensureData(response?.data?.data, 'Hydra head close response was not returned by the API');
}

export async function fanoutHydraHead(apiClient: Client, payload: { headId: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraHeadLifecycleResponse>({
        responseType: 'json',
        url: '/hydra/head/fanout',
        body: payload,
      }),
    { errorMessage: 'Failed to fanout Hydra head' },
  );

  return ensureData(response?.data?.data, 'Hydra head fanout response was not returned by the API');
}
