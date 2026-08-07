import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import { extractApiErrorMessage } from '@/lib/api-error';
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
  /** The head this node serves, when it has one. */
  HydraHead?: { status: HydraHeadStatus } | null;
  nodeUrl: string;
  nodeHttpUrl: string;
  hasCommitted: boolean;
  commitTxHash: string | null;
  /**
   * The node's own Cardano key hash, the head's on-chain identity, kept
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
  /** After this, the head can no longer absorb the deposit. Null while preparing. */
  deadline?: string | null;
  /** Before this, the head will not take it however confirmed the transaction is. */
  usableFrom?: string | null;
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
 * action's own request does not carry the result, the status arrives from
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
  /**
   * Lovelace the head reports holding that L1 no longer backs.
   *
   * hydra-node can keep a deposit in its L2 ledger that was never really
   * absorbed, so the balance reads high by this much.
   */
  unbackedLovelace?: string;
  hasUnbackedUtxos?: boolean;
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
 * redeeming theirs, there is no other path. Relations are a consequence of a
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
  /** Which side the issuer takes. Ours has to be the other one. */
  issuerWalletRole?: 'Buyer' | 'Seller';
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

/**
 * Top up the node's own Cardano key.
 *
 * A node cannot open a head from an empty address, Init consumes a seed UTxO
 * there, so a freshly provisioned node fails with `NoSeedInput` until this has
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
  /** What kind of money movement this row is. Absent on older payloads. */
  kind?: 'Ledger' | 'Deposit' | 'NodeFunding';
  /** Amount moved, for deposits and node funding. */
  lovelace?: string | null;
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
  /** Whether our node is in the Hydra cluster, so the counterparty's node is reachable. */
  peerConnected?: boolean | null;
  headId: string;
  connected: boolean;
  nodeState: string;
  isReady: boolean;
  reason: string | null;
  /**
   * Ways the head's own ledger no longer matches the chain it settles on.
   *
   * Empty in the normal case. A head's ledger is frozen when it opens, so a
   * chain that moves afterwards can leave the head holding outputs L1 will
   * refuse to take back at settlement.
   */
  paramDrift?: Array<{ parameter: string; head: number; chain: number; blocksFanout: boolean }>;
  checkedAt: string;
};

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

export type HydraTopup = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'Preparing' | 'Pending' | 'Confirmed' | 'Failed' | 'Recovered' | 'Absorbed';
  /** Null until the deposit is built; a preparing top-up has no deposit yet. */
  depositTxHash: string | null;
  /** The L1 split that carves the exact amount, present while preparing. */
  splitTxHash?: string | null;
  committedLovelace: string;
  committedAssets: Record<string, string>;
  /** After this, the head can no longer absorb the deposit. Null while preparing. */
  deadline?: string | null;
  /** Before this, the head will not take it however confirmed the transaction is. */
  usableFrom?: string | null;
  /**
   * Set once the node has been asked to send this deposit back to the wallet.
   *
   * Read from the record rather than remembered by the page: a recovery leaves
   * no other mark on the deposit, so without this a reload offered the button
   * again at funds already on their way home.
   */
  recoveryRequestedAt?: string | null;
};

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
      return response?.data?.data?.topups ?? [];
    },
    enabled: !!apiClient && headId !== null && isOpen,
    staleTime: 5000,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((topup) => topup.status === 'Pending') ? 10_000 : false,
  });

  return { ...query, topups: query.data ?? [] };
}

export type HydraWithdrawal = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'Preparing' | 'Pending' | 'Approved' | 'Finalized' | 'Failed';
  /** The in-head split that carved the exact amount. Null when whole UTxOs went. */
  splitTxId: string | null;
  decommitTxId: string | null;
  /**
   * The L1 transaction that paid it out, once identified. The head does not
   * report this, so it is observed on chain; null until then.
   */
  l1TxId: string | null;
  requestedLovelace: string;
  /**
   * Native assets that left with it, as unit to quantity. A decommit removes
   * whole outputs, so the lovelace above is what carried them rather than the
   * point of the withdrawal.
   */
  requestedAssets: Record<string, string>;
  /**
   * What actually reached L1, once the withdrawal finalized. Null until then,
   * and routinely different from what was requested: a decommit takes whole
   * outputs and the decrement's fee comes out of the value that travels.
   */
  settledLovelace: string | null;
  settledAssets: Record<string, string> | null;
  destinationAddress: string;
  failureReason: string | null;
  /** The point of no return: the head has signed the removal. */
  approvedAt: string | null;
  /** When the funds became spendable on L1. */
  finalizedAt: string | null;
};

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
      return response?.data?.data?.withdrawals ?? [];
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
