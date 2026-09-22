import { useQuery } from '@tanstack/react-query';
import { getPaymentCount, getPurchaseCount, type GetPaymentCountData } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';

type CountFilter = Pick<
  GetPaymentCountData['query'],
  'filterOnChainState' | 'filterNeedsManualAction'
>;

export type TransactionTabCounts = {
  refundRequests: number;
  disputes: number;
  needsAction: number;
};

/**
 * Badge totals for the transactions tabs, from the payment + purchase count
 * endpoints. Those count every matching row on the server, whereas counting the
 * loaded list only saw its first page. Scoped like the list in useTransactions
 * (network + the selected source's type) so a badge matches its tab.
 */
export function useTransactionTabCounts() {
  const { apiClient, network, selectedPaymentSource } = useAppContext();
  const filterPaymentSourceType = selectedPaymentSource?.paymentSourceType;

  return useQuery({
    // 'transactions' prefix so resync('transactions') refreshes the badges too.
    queryKey: ['transactions', 'tab-counts', network, filterPaymentSourceType],
    queryFn: async (): Promise<TransactionTabCounts> => {
      const countBoth = async (filter: CountFilter) => {
        const query = { network, filterPaymentSourceType, ...filter };
        const [payments, purchases] = await Promise.all([
          getPaymentCount({ client: apiClient, query }),
          getPurchaseCount({ client: apiClient, query }),
        ]);
        // Throw rather than toast: a failed count just leaves the badge off.
        if (payments.error || purchases.error) {
          throw new Error('Failed to load transaction counts');
        }
        return (payments.data?.data?.total ?? 0) + (purchases.data?.data?.total ?? 0);
      };

      const [refundRequests, disputes, needsAction] = await Promise.all([
        countBoth({ filterOnChainState: 'RefundRequested' }),
        countBoth({ filterOnChainState: 'Disputed' }),
        countBoth({ filterNeedsManualAction: 'true' }),
      ]);
      return { refundRequests, disputes, needsAction };
    },
    // Wait for the selected source: without its type the server scopes counts to
    // V1, so the first round would be wrong for a V2 source and then refetched.
    enabled: !!apiClient && !!selectedPaymentSource,
    staleTime: 15000,
  });
}
