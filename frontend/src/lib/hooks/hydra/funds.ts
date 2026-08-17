/**
 * Money moving into, inside and out of a head: balances, deposits, withdrawals
 * and the fuel a node spends on L1.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { Client } from '@/lib/api/generated/client';
import { ensureData } from './api';
import type { ApiEnvelope, HydraHeadBalanceResponse, HydraHeadTopupResponse } from './api';
import type {
  HydraHeadBalance,
  HydraNodeFunding,
  HydraTopup,
  HydraTopupRequest,
  HydraWithdrawal,
} from './types';

export async function fetchHydraHeadBalance(
  apiClient: Client,
  headId: string,
): Promise<HydraHeadBalance | null> {
  const response = await handleApiCall(
    () =>
      apiClient.get<HydraHeadBalanceResponse>({
        responseType: 'json',
        url: '/hydra/head/balance',
        query: { headId },
      }),
    {
      onError: (error: unknown) => {
        console.error('Failed to fetch Hydra head balance:', error);
      },
      errorMessage: 'Failed to load Hydra head balance',
    },
  );
  // Thrown rather than returned as null. React Query keeps the previous data
  // for a failed refetch and drops it for a successful empty one, and the
  // difference is not cosmetic here: the withdraw form derives its asset list
  // from this balance, so a null turned a head holding tokens into a head
  // holding none, silently reset the chosen asset to ADA, and left the typed
  // amount in place — a token amount about to be submitted as lovelace.
  if (response?.data?.data == null) {
    throw new Error('Failed to load Hydra head balance');
  }
  return response.data.data;
}

/**
 * Poll this node's own in-head balance for an OPEN head. Only enabled for open
 * heads (a live snapshot read requires an active connection).
 */
export function useHydraHeadBalance(headId: string | null, isOpen: boolean) {
  const { apiClient } = useAppContext();

  return useQuery<HydraHeadBalance | null>({
    queryKey: ['hydra-head-balance', headId],
    queryFn: async () => (headId ? fetchHydraHeadBalance(apiClient, headId) : null),
    enabled: !!apiClient && !!headId && isOpen,
    staleTime: 10000,
    refetchInterval: 15000,
  });
}

/**
 * Deposits into a head, newest first.
 *
 * Polled while any are pending: a top-up takes minutes, an exact amount is
 * split into its own UTxO and that split must confirm before the deposit can be
 * built, so this is the only way to tell progress from failure.
 */
export function useHydraTopups(headId: string | null, isOpen: boolean) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraTopup[]>({
    queryKey: ['hydra-topups', headId],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          apiClient.get<{ 200: ApiEnvelope<{ topups: HydraTopup[] }> }>({
            responseType: 'json',
            url: '/hydra/head/topup',
            query: { headId, limit: 10 },
          }),
        { errorMessage: 'Failed to load the deposits' },
      );
      // A failed read is not an empty list: rendered as one, the Deposits
      // section disappears entirely — no rows, no error, no retry — and the
      // polling that would bring it back keys on pending rows that are no
      // longer there. An operator reads that as "the deposit never happened"
      // and sends another.
      if (response?.data?.data?.topups == null) {
        throw new Error('Failed to load the deposits');
      }
      return response.data.data.topups;
    },
    enabled: !!apiClient && headId !== null && isOpen,
    staleTime: 5000,
    // Preparing counts as in flight, exactly as it does for withdrawals below.
    // It is the state every exact-amount deposit starts in and stays in while
    // its L1 pre-split confirms — minutes — and keying the poll on Pending
    // alone meant the row sat at "Preparing / amount pending" until the
    // operator reloaded the page by hand.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((topup) => ['Preparing', 'Pending'].includes(topup.status))
        ? 10_000
        : false,
  });

  return { ...query, topups: query.data ?? [] };
}

/**
 * Withdrawals out of a head, newest first.
 *
 * Polled until every one has settled. A withdrawal crosses two systems, the
 * head signs the removal, then its node posts the L1 payout, and neither leg
 * reports back to the request that started it, so the list is the only place
 * progress appears.
 */
/**
 * How long to watch for a newly started withdrawal to appear.
 *
 * Generous: it covers an in-head split being confirmed by the head before the
 * decommit is even requested.
 */
const WITHDRAWAL_APPEARS_WITHIN_MS = 90_000;

export function useHydraWithdrawals(
  headId: string | null,
  isOpen: boolean,
  /**
   * When a withdrawal was last started here, if one was.
   *
   * The request returns before the row exists — starting one is several steps,
   * including an in-head split — so refetching on the reply found nothing and
   * the row only appeared on a manual reload. Polling keyed on the rows alone
   * cannot close that gap, because at that moment there are no rows to key on.
   */
  startedAt: number | null = null,
) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraWithdrawal[]>({
    queryKey: ['hydra-withdrawals', headId],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          apiClient.get<{ 200: ApiEnvelope<{ withdrawals: HydraWithdrawal[] }> }>({
            responseType: 'json',
            url: '/hydra/head/withdraw',
            query: { headId, limit: 10 },
          }),
        { errorMessage: 'Failed to load the withdrawals' },
      );
      if (response?.data?.data?.withdrawals == null) {
        throw new Error('Failed to load the withdrawals');
      }
      return response.data.data.withdrawals;
    },
    enabled: !!apiClient && headId !== null && isOpen,
    staleTime: 5000,
    // Approved counts as in flight: the funds have left the head but L1 has not
    // reported them yet, which is exactly when an operator is watching.
    refetchInterval: (query) => {
      const inFlight = (query.state.data ?? []).some((row) =>
        ['Preparing', 'Pending', 'Approved'].includes(row.status),
      );
      if (inFlight) return 5_000;
      // Nothing in flight yet, but one was just asked for: watch briefly for it
      // to appear rather than leaving the operator looking at an empty list
      // after being told it would show up here.
      if (startedAt !== null && Date.now() - startedAt < WITHDRAWAL_APPEARS_WITHIN_MS) return 2_000;
      return false;
    },
  });

  return { ...query, withdrawals: query.data ?? [] };
}

export async function withdrawFromHydraHead(
  apiClient: Client,
  payload: {
    headId: string;
    lovelace?: string;
    assetUnit?: string;
    assetAmount?: string;
    drain?: boolean;
  },
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{ 200: ApiEnvelope<{ headId: string; accepted: true }> }>({
        responseType: 'json',
        url: '/hydra/head/withdraw',
        body: payload,
      }),
    { errorMessage: 'Failed to withdraw from the Hydra head' },
  );

  return ensureData(response?.data?.data, 'The withdrawal response was not returned by the API');
}

/** What the node's own key holds, read before an L1 action rather than after it fails. */
export async function readHydraNodeFunding(apiClient: Client, payload: { id: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.get<{ 200: ApiEnvelope<HydraNodeFunding> }>({
        responseType: 'json',
        url: '/hydra/participant/local/fund',
        query: payload,
      }),
    { errorMessage: "Failed to read the node's balance" },
  );

  return ensureData(response?.data?.data, 'The node balance was not returned by the API');
}

export async function fundHydraNode(apiClient: Client, payload: { id: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{
        200: ApiEnvelope<{
          address: string;
          balanceLovelace: string;
          transferredLovelace: string | null;
        }>;
      }>({
        responseType: 'json',
        url: '/hydra/participant/local/fund',
        body: payload,
      }),
    { errorMessage: 'Failed to fund the node' },
  );

  return ensureData(response?.data?.data, 'The funding result was not returned by the API');
}

/**
 * Sweep a finished node's unspent fuel back to its wallet.
 *
 * A node serves one head and is never reused, so without this every head
 * strands whatever its node did not spend.
 */
export async function withdrawHydraNodeFunds(apiClient: Client, payload: { id: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{
        200: ApiEnvelope<{
          address: string;
          balanceLovelace: string;
          txHash: string | null;
          reason: string | null;
        }>;
      }>({
        responseType: 'json',
        url: '/hydra/participant/local/withdraw',
        body: payload,
      }),
    { errorMessage: 'Failed to withdraw the node funds' },
  );

  return ensureData(response?.data?.data, 'The withdrawal result was not returned by the API');
}

/**
 * Ask the node to return a deposit the head never absorbed.
 *
 * The funds are at a deposit script, not in the wallet, and only the node can
 * spend them back.
 */
export async function recoverHydraTopup(apiClient: Client, payload: { topupId: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{
        200: ApiEnvelope<{ depositTxHash: string; requested: boolean; reason: string | null }>;
      }>({
        responseType: 'json',
        url: '/hydra/head/topup/recover',
        body: payload,
      }),
    { errorMessage: 'Could not request the recovery' },
  );

  return ensureData(response?.data?.data, 'The recovery result was not returned by the API');
}

export async function topupHydraHead(apiClient: Client, payload: HydraTopupRequest) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraHeadTopupResponse>({
        responseType: 'json',
        url: '/hydra/head/topup',
        body: payload,
      }),
    { errorMessage: 'Failed to top up Hydra head' },
  );

  return ensureData(response?.data?.data, 'Hydra head top-up response was not returned by the API');
}
