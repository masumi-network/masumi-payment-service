import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { Client } from '@/lib/api/generated/client';

export type HydraHeadStatus =
  | 'Disconnected'
  | 'Connected'
  | 'Connecting'
  | 'Idle'
  | 'Initializing'
  | 'Open'
  | 'Closed'
  | 'FanoutPossible'
  | 'Final';

export type HydraParticipant = {
  id: string;
  createdAt: string;
  updatedAt?: string;
  hydraHeadId?: string | null;
  walletId: string;
  /** The settling wallet's address. Absent on older payloads. */
  Wallet?: { walletAddress: string };
  nodeUrl: string;
  nodeHttpUrl: string;
  hasCommitted: boolean;
  commitTxHash: string | null;
  /**
   * The node's own Cardano key hash — the head's on-chain identity, kept
   * separate from the settling wallet so a node compromise cannot reach funds.
   */
  cardanoVkey?: string;
  /** Which connected node runs this participant's hydra-node process. */
  hydraHostId?: string;
  hostNodeId?: string;
  /** Null until an operator has taken the one-time backup of this node's keys. */
  keysDisclosedAt?: string | null;
};

export type HydraNodeKeys = {
  id: string;
  disclosedAt: string;
  hydraSigningKey: string;
  cardanoSigningKey: string | null;
};

/**
 * The counterparty's node, as agreed in the handshake.
 *
 * No node URL: their API sits behind their own Host's proxy and we hold no
 * token for it. What we have is the peer-plane address etcd dials.
 */
export type HydraRemoteParticipant = Omit<HydraParticipant, 'nodeUrl' | 'nodeHttpUrl'> & {
  advertise: string;
  hydraVerificationKeyId: string;
};

export type HydraHead = {
  id: string;
  createdAt: string;
  updatedAt: string;
  hydraRelationId: string;
  headIdentifier: string | null;
  status: HydraHeadStatus;
  contestationPeriod: string;
  isEnabled: boolean;
  openedAt: string | null;
  closedAt: string | null;
  finalizedAt: string | null;
  contestationDeadline: string | null;
  latestActivityAt: string | null;
  latestSnapshotNumber: string;
  initTxHash: string | null;
  closeTxHash: string | null;
  fanoutTxHash: string | null;
  /** Absent for heads that predate invites; decides which side may Init. */
  Invite?: { role: 'Issuer' | 'Redeemer' } | null;
  LocalParticipant?: HydraParticipant | null;
  RemoteParticipants?: HydraRemoteParticipant[];
  _count?: {
    Errors: number;
    Transactions: number;
  };
};

export type HydraWalletSummary = {
  id: string;
  walletVkey: string;
  walletAddress: string;
  type: string;
  note: string | null;
};

export type HydraRelation = {
  id: string;
  createdAt: string;
  updatedAt: string;
  network: 'Preprod' | 'Mainnet';
  localHotWalletId: string;
  remoteWalletId: string;
  counterpartyBaseUrl: string | null;
  LocalHotWallet?: HydraWalletSummary;
  RemoteWallet?: HydraWalletSummary;
  _count?: {
    Heads: number;
  };
};

export type HydraWalletBase = {
  id: string;
  createdAt: string;
  updatedAt: string;
  paymentSourceId: string;
  type: string;
  walletVkey: string;
  walletAddress: string;
  note: string | null;
  PaymentSource: {
    id: string;
    network: 'Preprod' | 'Mainnet';
    paymentSourceType: string;
  };
};

export type HydraNodeCheckResult = {
  reachable: boolean;
  protocolParametersOk: boolean;
  websocketReachable: boolean;
  httpStatus: number | null;
  status: HydraHeadStatus | null;
  checkedAt: string;
  error: string | null;
};

export type CreateHydraRelationPayload = {
  network: 'Preprod' | 'Mainnet';
  localHotWalletId: string;
  remoteWalletId: string;
  /** Where this relation's head offers are delivered. */
  counterpartyBaseUrl: string;
};

type ApiEnvelope<T> = {
  status: 'success';
  data: T;
};

type HydraHeadsResponses = {
  200: ApiEnvelope<{
    heads: HydraHead[];
  }>;
};

type HydraRelationsResponses = {
  200: ApiEnvelope<{
    relations: HydraRelation[];
  }>;
};

type HydraLocalParticipantsResponses = {
  200: ApiEnvelope<{
    participants: HydraParticipant[];
  }>;
};

type HydraRemoteParticipantsResponses = {
  200: ApiEnvelope<{
    participants: HydraRemoteParticipant[];
  }>;
};

type HydraWalletBasesResponses = {
  200: ApiEnvelope<{
    wallets: HydraWalletBase[];
  }>;
};

type HydraRelationResponse = {
  200: ApiEnvelope<HydraRelation>;
};

type HydraLocalParticipantResponse = {
  200: ApiEnvelope<{
    participant: HydraParticipant;
  }>;
};

type HydraRemoteParticipantResponse = {
  200: ApiEnvelope<{
    participant: HydraRemoteParticipant;
  }>;
};

type HydraHeadResponse = {
  200: ApiEnvelope<HydraHead>;
};

type HydraHeadLifecycleResponse = {
  200: ApiEnvelope<{
    headId: string;
    status: HydraHeadStatus;
  }>;
};

type HydraHeadCommitResponse = {
  200: ApiEnvelope<{
    headId: string;
    committed: boolean;
    commitTxHash: string | null;
  }>;
};

export type HydraTopupResult = {
  headId: string;
  topupId: string;
  depositTxHash: string;
  confirmed: boolean;
  committedLovelace: string;
  committedAssets: Record<string, string>;
};

export type HydraTopupRequest = {
  headId: string;
  /** Ignored when assetUnit is set. */
  assetFilter?: 'all' | 'ada-only';
  /** policyId+assetName hex; commit only UTxOs containing this token. */
  assetUnit?: string;
  /** Exact amount (base unit) to pre-split then commit; overrides the filter. */
  exactAmount?: string;
};

type HydraHeadTopupResponse = {
  200: ApiEnvelope<HydraTopupResult>;
};

type HydraNodeCheckResponse = {
  200: ApiEnvelope<HydraNodeCheckResult>;
};

type HydraWalletBaseResponse = {
  200: ApiEnvelope<HydraWalletBase>;
};

function ensureData<T>(value: T | undefined | null, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

async function fetchHydraPages<T extends { id: string }>(
  apiClient: Client,
  url: string,
  dataKey: string,
  query?: Record<string, string | number | boolean | undefined>,
) {
  const items: T[] = [];
  let cursorId: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const response = await handleApiCall(
      () =>
        apiClient.get<Record<200, ApiEnvelope<Record<string, T[]>>>>({
          responseType: 'json',
          url,
          query: {
            limit: 100,
            ...query,
            ...(cursorId ? { cursorId } : {}),
          },
        }),
      {
        onError: (error: unknown) => {
          console.error(`Failed to fetch ${url}:`, error);
        },
        errorMessage: `Failed to load ${url}`,
      },
    );

    const pageItems = response?.data?.data?.[dataKey] ?? [];
    items.push(...pageItems);

    hasMore = pageItems.length === 100;
    cursorId = pageItems.at(-1)?.id;

    if (!cursorId) {
      hasMore = false;
    }
  }

  return items;
}

/**
 * Head states that are waiting on the chain rather than on the operator.
 *
 * A head sits in one of these for a block or two after an action, and the
 * action's own request does not carry the result — the status arrives from
 * frames the node pushes. Without polling, an operator who opened a head saw
 * Idle until they reloaded, which reads as "nothing happened".
 */
const SETTLING_STATUSES: HydraHeadStatus[] = ['Initializing', 'Connecting', 'Closed'];

export function useHydraHeads() {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraHead[]>({
    queryKey: ['hydra-heads'],
    queryFn: async () => {
      return fetchHydraPages<HydraHead>(apiClient, '/hydra/head', 'heads');
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

// --- Own in-head balance (this node's committed funds in the head) ---

export type HydraHeadBalanceAsset = {
  /** Empty string for ADA/lovelace; otherwise policyId+assetName hex. */
  unit: string;
  quantity: string;
};

export type HydraHeadBalance = {
  hydraHeadId: string;
  address: string;
  /** False when the head has no live connection (balance unknown, not zero). */
  connected: boolean;
  utxoCount: number;
  balance: HydraHeadBalanceAsset[];
};

type HydraHeadBalanceResponse = {
  200: ApiEnvelope<HydraHeadBalance>;
};

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
  return response?.data?.data ?? null;
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

/**
 * Everything about invites.
 *
 * A head is opened by issuing an invite and having someone redeem it, or by
 * redeeming theirs — there is no other path. Relations are a consequence of a
 * redemption rather than something created here.
 */
export type HydraInvite = {
  id: string;
  nonce: string;
  network: 'Preprod' | 'Mainnet';
  role: 'Issuer' | 'Redeemer';
  status: 'Issued' | 'Redeemed' | 'Started' | 'Completed' | 'Expired' | 'Revoked';
  createdAt: string;
  expiresAt: string;
  hydraHostId: string;
  hostNodeId: string;
  issuerWalletAddress: string;
  issuerExchangeUrl: string;
  redeemedAt: string | null;
  redeemerWalletAddress: string | null;
  hydraHeadId: string | null;
};

export type HydraInvitePreview = {
  nonce: string;
  network: 'Preprod' | 'Mainnet';
  issuerWalletAddress: string;
  advertise: string;
  exchangeUrl: string;
  expiresAt: string;
  contestationPeriodSeconds: number;
  depositPeriodSeconds: number;
  unsyncedPeriodSeconds: number;
  signatureValid: boolean;
  alreadyKnown: boolean;
  identity: {
    policyId: string;
    entries: { unit: string; assetName: string; name: string | null }[];
    lookupError: string | null;
  };
};

export function useHydraInvites() {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraInvite[]>({
    queryKey: ['hydra-invites'],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          apiClient.get<{ 200: ApiEnvelope<{ invites: HydraInvite[] }> }>({
            responseType: 'json',
            url: '/hydra/invite',
            query: { limit: 100 },
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
 * it is revoked, or it expires — a node cannot be re-pointed at a different
 * counterparty once issued.
 */
export async function createHydraInvite(
  apiClient: Client,
  payload: { hotWalletId: string; ttlHours?: number },
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
 * call on an invite of unknown provenance — which is the point: the operator
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
  payload: { code: string; hotWalletId: string },
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
 * also once-only — it seals itself server-side — so whatever comes back has to
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

/**
 * Top up the node's own Cardano key.
 *
 * A node cannot open a head from an empty address — Init consumes a seed UTxO
 * there — so a freshly provisioned node fails with `NoSeedInput` until this has
 * run. A scheduled cycle does it too; this is for not waiting.
 */
export type HydraHeadError = {
  id: string;
  errorType: string;
  errorMessage: string;
  headStatus: string;
  clientInput: string | null;
  txHash: string | null;
  errorAt: string;
};

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
      return response?.data?.data?.errors ?? [];
    },
    enabled: !!apiClient && headId !== null,
    staleTime: 10000,
  });

  return { ...query, errors: query.data ?? [] };
}

export type HydraHeadTransaction = {
  id: string;
  createdAt: string;
  txHash: string | null;
  intendedTxHash: string | null;
  status: string;
  layer: 'L1' | 'L2';
  confirmations: number | null;
  fees: string | null;
  blockTime: number | null;
  lastCheckedAt: string | null;
};

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
      return response?.data?.data?.transactions ?? [];
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

export type HydraHeadConnection = {
  headId: string;
  connected: boolean;
  nodeState: string;
  isReady: boolean;
  reason: string | null;
  checkedAt: string;
};

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

export type HydraTopup = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'Pending' | 'Confirmed' | 'Failed';
  depositTxHash: string;
  committedLovelace: string;
  committedAssets: Record<string, string>;
};

/**
 * Deposits into a head, newest first.
 *
 * Polled while any are pending: a top-up takes minutes — an exact amount is
 * split into its own UTxO and that split must confirm before the deposit can be
 * built — so this is the only way to tell progress from failure.
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
      return response?.data?.data?.topups ?? [];
    },
    enabled: !!apiClient && headId !== null && isOpen,
    staleTime: 5000,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((topup) => topup.status === 'Pending') ? 10_000 : false,
  });

  return { ...query, topups: query.data ?? [] };
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

export type HydraNodeFunding = {
  address: string;
  balanceLovelace: string;
  isUnderfunded: boolean;
  shortfallLovelace: string;
  checked: boolean;
  /**
   * Provisioned is not ready: a node must start and sync before it can post.
   *
   * Optional because a service that predates it simply omits it, and the dialog
   * has to keep working against one.
   */
  node?: { state: string; isReady: boolean; reason: string | null };
};

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

export async function closeHydraHead(apiClient: Client, payload: { headId: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraHeadLifecycleResponse>({
        responseType: 'json',
        url: '/hydra/head/close',
        body: payload,
      }),
    { errorMessage: 'Failed to close Hydra head' },
  );

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

// A counterparty's wallet is no longer entered by hand: it arrives inside a
// signed invite, and the relation is created when that invite is redeemed.

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
