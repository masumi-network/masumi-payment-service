import { getRegistry, type RegistryEntry } from '@/lib/api/generated';
import type { Client } from '@/lib/api/generated/client';
import { appendInclusiveCursorPage } from '@/lib/pagination/cursor-pagination';
import { parseAmountSearchRange } from '@/lib/parseAmountSearchRange';
import { handleApiCall } from '@/lib/utils';
import type { NetworkType } from '@/lib/contexts/AppContext';

export const MAX_AGENT_NAME_SEARCH_MATCHES = 10;
const REGISTRY_PAGE_SIZE = 50;
const MAX_REGISTRY_PAGES = 5;

/** True when the query is plausibly an agent name (not hash, amount, or bare id fragment). */
export function shouldSearchTransactionsByAgentName(searchQuery: string | undefined): boolean {
  const query = searchQuery?.trim() ?? '';
  if (query.length < 2) return false;
  if (parseAmountSearchRange(query.toLowerCase())) return false;
  if (/^[a-f0-9]{64}$/i.test(query)) return false;
  if (/^[a-f0-9]+$/i.test(query)) return false;
  if (!/[a-z]/i.test(query)) return false;
  return true;
}

async function fetchRegistryAgentsByName(
  apiClient: Client,
  network: NetworkType,
  searchQuery: string,
): Promise<RegistryEntry[]> {
  let items: RegistryEntry[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_REGISTRY_PAGES; page++) {
    const response = await handleApiCall(
      () =>
        getRegistry({
          client: apiClient,
          query: {
            network,
            cursorId: cursor,
            limit: REGISTRY_PAGE_SIZE,
            searchQuery,
          },
        }),
      { errorMessage: 'Failed to search agents by name' },
    );

    const batch = (response?.data?.data?.Assets ?? []) as RegistryEntry[];
    items = appendInclusiveCursorPage(items, batch, (agent) => agent.id);

    if (batch.length < REGISTRY_PAGE_SIZE) break;
    const last = batch[batch.length - 1];
    if (!last?.id || last.id === cursor) break;
    cursor = last.id;
  }

  return items;
}

export type AgentNameSearchResolution = {
  identifiers: string[];
  nameByIdentifier: Map<string, string>;
};

/** Resolve registry rows whose name matches `searchQuery` to on-chain agent identifiers. */
export async function resolveAgentIdentifiersByName(
  apiClient: Client,
  network: NetworkType,
  searchQuery: string,
): Promise<AgentNameSearchResolution> {
  const agents = await fetchRegistryAgentsByName(apiClient, network, searchQuery);
  const nameByIdentifier = new Map<string, string>();
  const identifiers: string[] = [];

  for (const agent of agents) {
    const identifier = agent.agentIdentifier?.trim();
    if (!identifier || nameByIdentifier.has(identifier)) continue;
    nameByIdentifier.set(identifier, agent.name);
    identifiers.push(identifier);
    if (identifiers.length >= MAX_AGENT_NAME_SEARCH_MATCHES) break;
  }

  return { identifiers, nameByIdentifier };
}
