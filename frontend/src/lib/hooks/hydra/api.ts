/**
 * How this client talks to the Hydra API: response envelopes and paging.
 *
 * Internal to the Hydra hooks. Nothing here is exported from the barrel — a
 * caller wants a hook, not a page loop.
 */

import { handleApiCall } from '@/lib/utils';
import type { Client } from '@/lib/api/generated/client';
import type {
  HydraHead,
  HydraHeadBalance,
  HydraHeadStatus,
  HydraNodeCheckResult,
  HydraParticipant,
  HydraRelation,
  HydraRemoteParticipant,
  HydraTopupResult,
  HydraWalletBase,
} from './types';

export type ApiEnvelope<T> = {
  status: 'success';
  data: T;
};

export type HydraHeadsResponses = {
  200: ApiEnvelope<{
    heads: HydraHead[];
  }>;
};

export type HydraRelationsResponses = {
  200: ApiEnvelope<{
    relations: HydraRelation[];
  }>;
};

export type HydraLocalParticipantsResponses = {
  200: ApiEnvelope<{
    participants: HydraParticipant[];
  }>;
};

export type HydraRemoteParticipantsResponses = {
  200: ApiEnvelope<{
    participants: HydraRemoteParticipant[];
  }>;
};

export type HydraWalletBasesResponses = {
  200: ApiEnvelope<{
    wallets: HydraWalletBase[];
  }>;
};

export type HydraRelationResponse = {
  200: ApiEnvelope<HydraRelation>;
};

export type HydraLocalParticipantResponse = {
  200: ApiEnvelope<{
    participant: HydraParticipant;
  }>;
};

export type HydraRemoteParticipantResponse = {
  200: ApiEnvelope<{
    participant: HydraRemoteParticipant;
  }>;
};

export type HydraHeadResponse = {
  200: ApiEnvelope<HydraHead>;
};

export type HydraHeadLifecycleResponse = {
  200: ApiEnvelope<{
    headId: string;
    status: HydraHeadStatus;
  }>;
};

export type HydraHeadCommitResponse = {
  200: ApiEnvelope<{
    headId: string;
    committed: boolean;
    commitTxHash: string | null;
  }>;
};

export type HydraHeadTopupResponse = {
  200: ApiEnvelope<HydraTopupResult>;
};

export type HydraNodeCheckResponse = {
  200: ApiEnvelope<HydraNodeCheckResult>;
};

export type HydraWalletBaseResponse = {
  200: ApiEnvelope<HydraWalletBase>;
};

export type HydraHeadBalanceResponse = {
  200: ApiEnvelope<HydraHeadBalance>;
};

export function ensureData<T>(value: T | undefined | null, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

export async function fetchHydraPages<T extends { id: string }>(
  apiClient: Client,
  url: string,
  dataKey: string,
  query?: Record<string, string | number | boolean | undefined>,
) {
  const items: T[] = [];
  // The API's cursor is inclusive by design: paging from a row returns that row
  // again as the first item of the next page, and deduping is the client's job.
  // Without this, every page boundary produced a duplicate id — a React key
  // collision, and a count that grew by one per 100 rows.
  const seenIds = new Set<string>();
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
    for (const item of pageItems) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      items.push(item);
    }

    // Counted against what the page returned, not what survived deduping: the
    // repeated cursor row is what makes a full page, so measuring the deduped
    // length would stop one row early on every boundary.
    hasMore = pageItems.length === 100;
    cursorId = pageItems.at(-1)?.id;

    if (!cursorId) {
      hasMore = false;
    }
  }

  return items;
}
