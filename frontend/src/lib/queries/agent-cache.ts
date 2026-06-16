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
