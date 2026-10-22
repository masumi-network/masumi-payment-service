import { useCallback, useState } from 'react';
import {
  postPaymentAcknowledgeManualAction,
  postPurchaseAcknowledgeManualAction,
} from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import type { Transaction } from '@/components/transactions/transaction-format.helpers';
import { buildAcknowledgeBatches } from './useAcknowledgeNeedsAction.helpers';

export type AcknowledgeResult = {
  /** Rows the backend acknowledged. */
  acknowledged: number;
  /** Rows in batches whose request failed. */
  failed: number;
};

/**
 * Hides rows from Needs Action. Only the acknowledgement is stored: error
 * fields, transactions and on-chain state do not change, and a new error
 * shows the row again.
 */
export function useAcknowledgeNeedsAction() {
  const { apiClient, network: contextNetwork } = useAppContext();
  const [isAcknowledging, setIsAcknowledging] = useState(false);

  const acknowledge = useCallback(
    async (transactions: Transaction[]): Promise<AcknowledgeResult> => {
      setIsAcknowledging(true);
      let acknowledged = 0;
      let failed = 0;
      try {
        for (const batch of buildAcknowledgeBatches(transactions, contextNetwork)) {
          const body = {
            network: batch.network,
            blockchainIdentifiers: batch.blockchainIdentifiers,
          };
          try {
            const response =
              batch.type === 'purchase'
                ? await postPurchaseAcknowledgeManualAction({ client: apiClient, body })
                : await postPaymentAcknowledgeManualAction({ client: apiClient, body });
            if (response.error) failed += batch.blockchainIdentifiers.length;
            else acknowledged += response.data?.data?.acknowledgedCount ?? 0;
          } catch {
            failed += batch.blockchainIdentifiers.length;
          }
        }
      } finally {
        setIsAcknowledging(false);
      }
      return { acknowledged, failed };
    },
    [apiClient, contextNetwork],
  );

  return { acknowledge, isAcknowledging };
}
