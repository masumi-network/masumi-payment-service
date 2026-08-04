import { RegistryEntry } from '@/lib/api/generated';

/**
 * Display labels for the on-chain agent access model. `Standard` is Masumi's
 * native type — the DB/API enum keeps the `Standard` name for on-chain metadata
 * compatibility, but every user-facing surface calls it Masumi. Shared by the
 * AI-agents list column, the list type filter and the agent-details dialog so
 * the three never drift (the column and the filter previously carried separate
 * hardcoded label lists; see agent-status.ts, which exists for the same reason).
 * Exhaustive Record, so a new RegistryEntryType member fails the typecheck here
 * rather than shipping an unlabelled type. The `?? type` fallback covers the
 * runtime gap the typecheck cannot: a deployed frontend talking to a newer
 * backend receives a member its generated types predate, and showing the raw
 * enum name beats an empty badge.
 */
export const AGENT_TYPE_LABELS: Record<RegistryEntry['type'], string> = {
  Standard: 'Masumi',
  OpenApi: 'OpenAPI',
  X402: 'x402',
};

export const getAgentTypeLabel = (type: RegistryEntry['type']): string =>
  AGENT_TYPE_LABELS[type] ?? type;
