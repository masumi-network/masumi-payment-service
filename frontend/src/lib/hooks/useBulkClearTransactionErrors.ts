import { useCallback, useState } from 'react';
import { postPaymentErrorStateRecovery, postPurchaseErrorStateRecovery } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import type { Transaction } from '@/lib/hooks/useTransactions.helpers';

export type BulkClearResult = {
  succeeded: number;
  failed: number;
  /**
   * Transaction row ids (the unique DB id) that failed, so callers can keep
   * them selected. Keyed by id — NOT blockchainIdentifier, which a payment and
   * its paired purchase can share.
   */
  failedIds: string[];
};

const toRecoveryNetwork = (network: string | null | undefined): 'Preprod' | 'Mainnet' | null =>
  network === 'Preprod' || network === 'Mainnet' ? network : null;

/**
 * Clears the error state of many transactions by fanning out the single-row
 * recovery endpoints (there is no bulk endpoint). Calls run sequentially so a
 * flood of parallel recovery requests can't overwhelm the backend, and each
 * failure is isolated — one bad row does not abort the rest.
 */
export function useBulkClearTransactionErrors() {
  const { apiClient, network: contextNetwork } = useAppContext();
  const [isClearing, setIsClearing] = useState(false);

  const clearErrors = useCallback(
    async (transactions: Transaction[]): Promise<BulkClearResult> => {
      setIsClearing(true);
      const failedIds: string[] = [];
      let succeeded = 0;

      try {
        for (const transaction of transactions) {
          // Rows are selected by id, so id is always present here. Guard anyway
          // so a malformed row is reported as a failure rather than silently lost.
          const rowId = transaction.id;
          const recoveryNetwork = toRecoveryNetwork(
            transaction.PaymentSource?.network ?? contextNetwork,
          );
          // Recovery is only defined once a row is on-chain; initial-state rows
          // cannot be recovered and unsupported networks cannot be submitted.
          if (!rowId || !transaction.onChainState || !recoveryNetwork) {
            if (rowId) failedIds.push(rowId);
            continue;
          }

          try {
            const body = {
              blockchainIdentifier: transaction.blockchainIdentifier,
              updatedAt: new Date(transaction.updatedAt),
              network: recoveryNetwork,
            };
            const response =
              transaction.type === 'purchase'
                ? await postPurchaseErrorStateRecovery({ client: apiClient, body })
                : await postPaymentErrorStateRecovery({ client: apiClient, body });

            if (response.error) {
              failedIds.push(rowId);
            } else {
              succeeded += 1;
            }
          } catch {
            failedIds.push(rowId);
          }
        }
      } finally {
        setIsClearing(false);
      }

      return { succeeded, failed: failedIds.length, failedIds };
    },
    [apiClient, contextNetwork],
  );

  return { clearErrors, isClearing };
}
