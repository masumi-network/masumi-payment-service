import type { QueryClient } from '@tanstack/react-query';

/**
 * Agent registry lists are cached under two independent query keys:
 * - `['agents']` — the dashboard and testing dialogs (via `useAgents`).
 * - `['context-agents']` — the rail-aware AI Agents page (via `useContextAgents`).
 *
 * Any mutation that changes registry entries (register, deregister, delete, migrate,
 * setup registration, metadata update) must invalidate BOTH, or one view stays stale
 * until manual refresh. Centralized here so new call sites can't drift to only one key.
 */
export function invalidateAgentQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['agents'] });
  void queryClient.invalidateQueries({ queryKey: ['context-agents'] });
}

/**
 * Like `invalidateAgentQueries`, but CLEARS the cached lists (back to a pending
 * state) before refetching. Use this after a mutation that changes list
 * membership (register / deregister / delete / re-register / migrate): the
 * current rows are now known-stale (they still include the deleted agent, or
 * miss the new one), so the list should drop to its skeleton while the fresh
 * data loads instead of showing stale rows. For passive refreshes (the refresh
 * button, balance updates) use `invalidateAgentQueries` so the data stays put.
 */
export function resetAgentQueries(queryClient: QueryClient): void {
  void queryClient.resetQueries({ queryKey: ['agents'] });
  void queryClient.resetQueries({ queryKey: ['context-agents'] });
}
