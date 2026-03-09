import { appendInclusiveCursorPage } from '@/lib/pagination/cursor-pagination';
import { Payment, Purchase } from '@/lib/api/generated';

type Transaction =
  | (Payment & { type: 'payment' })
  | (Purchase & {
      type: 'purchase';
    });

export const DOWNLOAD_PAGE_SIZE = 100;

export function buildTransactionDownloadQuery(network: 'Preprod' | 'Mainnet', cursorId?: string) {
  return {
    network,
    cursorId,
    includeHistory: 'true' as const,
    limit: DOWNLOAD_PAGE_SIZE,
  };
}

export function mergeDownloadedTransactions(
  existingTransactions: readonly Transaction[],
  nextTransactions: readonly Transaction[],
) {
  return appendInclusiveCursorPage(
    existingTransactions,
    nextTransactions,
    (transaction) => `${transaction.type}:${transaction.id ?? ''}`,
  );
}
