import { getPayment, getPurchase, type Payment, type Purchase } from '@/lib/api/generated';
import type { Client } from '@/lib/api/generated/client';
import { handleApiCall } from '@/lib/utils';
import type { NetworkType } from '@/lib/contexts/AppContext';
import { buildTransactionsPage, type TransactionsPage } from '@/lib/hooks/useTransactions.helpers';
import type { OnChainStateFilter } from '@/lib/hooks/useTransactions';
import type { PaymentSourceType } from '@/lib/payment-source-type';

const TRANSACTION_PAGE_SIZE = 10;

export type AgentIdentifierCursorState = {
  identifier: string;
  paymentCursorId?: string;
  purchaseCursorId?: string;
  hasMorePayments: boolean;
  hasMorePurchases: boolean;
};

export type AgentNameTransactionsPageParam = {
  identifiers: string[];
  cursors: AgentIdentifierCursorState[];
  nameByIdentifier: Map<string, string>;
};

type FetchPageOptions = {
  apiClient: Client;
  network: NetworkType;
  identifiers: string[];
  cursors: AgentIdentifierCursorState[];
  filterOnChainState?: OnChainStateFilter;
  filterPaymentSourceType?: PaymentSourceType;
  skipPayments: boolean;
  skipPurchases: boolean;
};

const getPaymentsFromResponse = (
  response: Awaited<ReturnType<typeof getPayment>> | null,
): Payment[] => response?.data?.data?.Payments ?? [];

const getPurchasesFromResponse = (
  response: Awaited<ReturnType<typeof getPurchase>> | null,
): Purchase[] => response?.data?.data?.Purchases ?? [];

function initCursors(
  identifiers: string[],
  options?: { skipPayments?: boolean; skipPurchases?: boolean },
): AgentIdentifierCursorState[] {
  return identifiers.map((identifier) => ({
    identifier,
    hasMorePayments: !options?.skipPayments,
    hasMorePurchases: !options?.skipPurchases,
  }));
}

export function hasMoreAgentIdentifierPages(cursors: AgentIdentifierCursorState[]): boolean {
  return cursors.some((cursor) => cursor.hasMorePayments || cursor.hasMorePurchases);
}

/** Fetch the next merged page of transactions for one or more agent identifiers. */
export async function fetchTransactionsByAgentIdentifiersPage(
  options: FetchPageOptions,
): Promise<{ page: TransactionsPage; cursors: AgentIdentifierCursorState[] }> {
  const payments: Payment[] = [];
  const purchases: Purchase[] = [];
  const nextCursors: AgentIdentifierCursorState[] = [];

  await Promise.all(
    options.cursors.map(async (cursor) => {
      const next: AgentIdentifierCursorState = { ...cursor };
      if (options.skipPayments) next.hasMorePayments = false;
      if (options.skipPurchases) next.hasMorePurchases = false;
      const fetches: Promise<void>[] = [];

      if (!options.skipPayments && cursor.hasMorePayments) {
        fetches.push(
          handleApiCall(
            () =>
              getPayment({
                client: options.apiClient,
                query: {
                  network: options.network,
                  cursorId: cursor.paymentCursorId,
                  includeHistory: 'true',
                  limit: TRANSACTION_PAGE_SIZE,
                  filterOnChainState: options.filterOnChainState,
                  filterPaymentSourceType: options.filterPaymentSourceType,
                  searchQuery: cursor.identifier,
                },
              }),
            { errorMessage: 'Failed to fetch payments' },
          ).then((response) => {
            const batch = getPaymentsFromResponse(response);
            payments.push(...batch);
            next.hasMorePayments = batch.length === TRANSACTION_PAGE_SIZE;
            if (batch.length > 0) {
              next.paymentCursorId = batch[batch.length - 1]?.id;
            }
          }),
        );
      }

      if (!options.skipPurchases && cursor.hasMorePurchases) {
        fetches.push(
          handleApiCall(
            () =>
              getPurchase({
                client: options.apiClient,
                query: {
                  network: options.network,
                  cursorId: cursor.purchaseCursorId,
                  includeHistory: 'true',
                  limit: TRANSACTION_PAGE_SIZE,
                  filterOnChainState: options.filterOnChainState,
                  filterPaymentSourceType: options.filterPaymentSourceType,
                  searchQuery: cursor.identifier,
                },
              }),
            { errorMessage: 'Failed to fetch purchases' },
          ).then((response) => {
            const batch = getPurchasesFromResponse(response);
            purchases.push(...batch);
            next.hasMorePurchases = batch.length === TRANSACTION_PAGE_SIZE;
            if (batch.length > 0) {
              next.purchaseCursorId = batch[batch.length - 1]?.id;
            }
          }),
        );
      }

      await Promise.all(fetches);
      nextCursors.push(next);
    }),
  );

  const page = buildTransactionsPage({
    payments,
    purchases,
    pageSize: TRANSACTION_PAGE_SIZE,
    skipPayments: options.skipPayments,
    skipPurchases: options.skipPurchases,
  });

  return { page, cursors: nextCursors };
}

export { initCursors, TRANSACTION_PAGE_SIZE };
