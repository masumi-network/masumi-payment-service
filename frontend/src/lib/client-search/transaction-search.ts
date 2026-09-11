import { ON_CHAIN_STATES } from '@/lib/hooks/useTransactions';
import { parseAmountSearchRange, parseAmountToBigInt } from '@/lib/parseAmountSearchRange';

const formatStatus = (status: string | null) => {
  if (!status) return '—';
  return status.replace(/([A-Z])/g, ' $1').trim();
};

type TransactionSearchRow = {
  id?: string | null;
  blockchainIdentifier?: string | null;
  onChainState?: string | null;
  agentIdentifier?: string | null;
  agentName?: string | null;
  type?: string | null;
  inputHash?: string | null;
  resultHash?: string | null;
  CurrentTransaction?: {
    txHash?: string | null;
    layer?: string | null;
    hydraHeadId?: string | null;
  } | null;
  TransactionHistory?: Array<{ txHash?: string | null }> | null;
  SmartContractWallet?: { walletAddress?: string | null } | null;
  RequestedFunds?: Array<{ amount?: string | null; unit?: string | null }> | null;
  PaidFunds?: Array<{ amount?: string | null; unit?: string | null }> | null;
};

/**
 * Client-side transaction search while server results are pending.
 * Mirrors buildTransactionSearchFilter in src/utils/shared/queries.ts.
 */
export function filterTransactionsClientSide<T extends TransactionSearchRow>(
  transactions: T[],
  searchQuery: string,
): T[] {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return transactions;

  const amountRange = parseAmountSearchRange(query);
  const isHashQuery = query.length >= 5 && /^[0-9a-f]+$/.test(query);
  const matchingLayer =
    query === 'hydra' ? 'L2' : query === 'l1' || query === 'l2' ? query.toUpperCase() : null;
  const matchingStates = ON_CHAIN_STATES.filter(
    (s) => s.toLowerCase().includes(query) || formatStatus(s).toLowerCase().includes(query),
  );

  return transactions.filter((tx) => {
    if (tx.id?.toLowerCase().includes(query)) return true;
    if (tx.blockchainIdentifier?.toLowerCase() === query) return true;
    if (isHashQuery) {
      if (tx.CurrentTransaction?.txHash?.toLowerCase().includes(query)) return true;
      if (tx.TransactionHistory?.some((h) => h.txHash?.toLowerCase().includes(query))) return true;
      if (tx.inputHash?.toLowerCase().includes(query)) return true;
      if (tx.resultHash?.toLowerCase().includes(query)) return true;
      if (tx.CurrentTransaction?.hydraHeadId?.toLowerCase().includes(query)) return true;
    }
    if (matchingLayer && tx.CurrentTransaction?.layer === matchingLayer) return true;
    if (tx.SmartContractWallet?.walletAddress?.toLowerCase().includes(query)) return true;
    if (
      matchingStates.length > 0 &&
      tx.onChainState &&
      matchingStates.includes(tx.onChainState as (typeof ON_CHAIN_STATES)[number])
    )
      return true;
    if (tx.agentIdentifier?.toLowerCase().includes(query)) return true;
    if (tx.agentName?.toLowerCase().includes(query)) return true;
    if (amountRange) {
      const funds =
        tx.type === 'payment' ? tx.RequestedFunds : tx.type === 'purchase' ? tx.PaidFunds : [];
      if (
        funds?.some((f) => {
          const amt = parseAmountToBigInt(f.amount);
          return amt != null && amt >= amountRange.min && amt <= amountRange.max;
        })
      )
        return true;
    }
    return false;
  });
}
