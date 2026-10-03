/**
 * Refresh what an action just changed.
 *
 * Query keys in this app are strings with no shared convention — `wallets`,
 * `wallets-paginated`, `all-wallets`, `payment-source-wallets-all` all describe
 * the same thing — so a caller trying to name the right ones after a mutation
 * either lists five keys or misses three. Several dialogs did neither: creating
 * a test payment, registering an agent or acting on a transaction left every
 * list on screen describing the world as it was before, until the operator
 * reloaded the page.
 *
 * Grouping by subject and matching on prefix keeps that decision in one place.
 * A caller says what it changed, not which caches happen to hold it.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

/**
 * Query-key prefixes per subject.
 *
 * Deliberately broad: refetching a list that did not change costs one request,
 * while missing one shows stale data that looks like a bug in the action the
 * operator just took.
 */
const SUBJECTS = {
  payments: ['payments', 'transactions', 'uninvoiced', 'invoices'],
  purchases: ['purchases', 'transactions', 'uninvoiced'],
  transactions: ['transactions', 'payments', 'purchases'],
  agents: ['agents', 'registry', 'context-agents', 'migrate-'],
  wallets: ['wallets', 'all-wallets', 'wallet-', 'payment-source-wallet', 'fundTransfers'],
  hydra: ['hydra'],
  x402: ['x402'],
  apiKeys: ['api-keys'],
  webhooks: ['webhooks'],
  paymentSources: ['payment-sources', 'payment-source-'],
} as const;

export type ResyncSubject = keyof typeof SUBJECTS;

export function useResync() {
  const queryClient = useQueryClient();

  return useCallback(
    async (...subjects: ResyncSubject[]) => {
      const prefixes = subjects.flatMap((subject) => SUBJECTS[subject] as readonly string[]);
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const head = query.queryKey[0];
          return typeof head === 'string' && prefixes.some((prefix) => head.startsWith(prefix));
        },
      });
    },
    [queryClient],
  );
}
