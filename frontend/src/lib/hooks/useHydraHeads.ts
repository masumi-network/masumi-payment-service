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
};

export type HydraRemoteParticipant = HydraParticipant & {
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
};

export type CreateHydraLocalParticipantPayload = {
  walletId: string;
  nodeUrl: string;
  nodeHttpUrl: string;
  hydraSK: string;
};

export type CreateHydraRemoteParticipantPayload = {
  walletId: string;
  nodeUrl: string;
  nodeHttpUrl: string;
  hydraVK: string;
};

export type CreateHydraHeadPayload = {
  hydraRelationId: string;
  contestationPeriod: number;
  localParticipantId: string;
  remoteParticipantIds: string[];
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

export function useHydraLocalParticipants(walletId?: string) {
  const { apiClient } = useAppContext();

  const query = useQuery<HydraParticipant[]>({
    queryKey: ['hydra-local-participants', walletId],
    queryFn: async () =>
      fetchHydraPages<HydraParticipant>(apiClient, '/hydra/participant/local', 'participants', {
        unassigned: true,
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

export async function createHydraLocalParticipant(
  apiClient: Client,
  payload: CreateHydraLocalParticipantPayload,
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraLocalParticipantResponse>({
        responseType: 'json',
        url: '/hydra/participant/local',
        body: payload,
      }),
    { errorMessage: 'Failed to create local Hydra participant' },
  );

  return ensureData(
    response?.data?.data?.participant,
    'Local Hydra participant was not returned by the API',
  );
}

export async function createHydraRemoteParticipant(
  apiClient: Client,
  payload: CreateHydraRemoteParticipantPayload,
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraRemoteParticipantResponse>({
        responseType: 'json',
        url: '/hydra/participant/remote',
        body: payload,
      }),
    { errorMessage: 'Failed to create remote Hydra participant' },
  );

  return ensureData(
    response?.data?.data?.participant,
    'Remote Hydra participant was not returned by the API',
  );
}

export async function createHydraHead(apiClient: Client, payload: CreateHydraHeadPayload) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraHeadResponse>({
        responseType: 'json',
        url: '/hydra/head',
        body: payload,
      }),
    { errorMessage: 'Failed to create Hydra head' },
  );

  return ensureData(response?.data?.data, 'Hydra head was not returned by the API');
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

export async function checkHydraNode(
  apiClient: Client,
  payload: { nodeHttpUrl: string; nodeUrl?: string; timeoutMs?: number },
) {
  const response = await handleApiCall(
    () =>
      apiClient.post<HydraNodeCheckResponse>({
        responseType: 'json',
        url: '/hydra/head/check',
        body: payload,
      }),
    { errorMessage: 'Failed to check Hydra node' },
  );

  return ensureData(response?.data?.data, 'Hydra node check was not returned by the API');
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
