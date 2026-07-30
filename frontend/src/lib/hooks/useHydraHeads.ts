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
  nodeUrl: string;
  nodeHttpUrl: string;
  hasCommitted: boolean;
  commitTxHash: string | null;
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

export function useHydraHeads() {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraHead[]>({
    queryKey: ['hydra-heads'],
    queryFn: async () => {
      return fetchHydraPages<HydraHead>(apiClient, '/hydra/head', 'heads');
    },
    enabled: !!apiClient,
    staleTime: 10000,
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

export async function createHydraRelation(apiClient: Client, payload: CreateHydraRelationPayload) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraRelationResponse>({
        responseType: 'json',
        url: '/hydra/relation',
        body: payload,
      }),
    { errorMessage: 'Failed to create Hydra relation' },
  );

  return ensureData(response?.data?.data, 'Hydra relation was not returned by the API');
}

/**
 * Open the next head on a relation.
 *
 * The only way to create one: the service provisions a node on a Hydra Host,
 * exchanges signed material with the counterparty, starts the node and records
 * the head. Nothing about the node is configured here.
 */
export async function proposeHydraHead(apiClient: Client, payload: { hydraRelationId: string }) {
  const response = await handleApiCall(
    () =>
      apiClient.post<{ 200: ApiEnvelope<{ offerId: string; nonce: string; status: string }> }>({
        responseType: 'json',
        url: '/hydra/handshake/propose',
        body: payload,
      }),
    { errorMessage: 'Failed to propose a Hydra head' },
  );

  return ensureData(response?.data?.data, 'The head offer was not returned by the API');
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

/**
 * Record a counterparty's wallet from the address they sent you.
 *
 * A relation is defined by whose wallet sits on each side, and the counterparty
 * is at another organisation — so their address arrives out of band and has to
 * be entered, not picked from a list of our own wallets.
 */
export async function recordHydraCounterpartyWallet(
  apiClient: Client,
  payload: { paymentSourceId: string; walletAddress: string; note?: string },
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraWalletBaseResponse>({
        responseType: 'json',
        url: '/hydra/wallet-base',
        body: payload,
      }),
    { errorMessage: 'Failed to record the counterparty wallet' },
  );

  return ensureData(response?.data?.data, 'The counterparty wallet was not returned by the API');
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
