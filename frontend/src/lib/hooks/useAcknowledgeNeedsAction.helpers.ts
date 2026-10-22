import type { Transaction } from '@/components/transactions/transaction-format.helpers';

/** Matches the backend limit on /payment|purchase/acknowledge-manual-action. */
export const ACKNOWLEDGE_BATCH_SIZE = 100;

export type AcknowledgeRequest = {
  blockchainIdentifier: string;
  /** As this page read it: the backend skips a row that changed since. */
  nextActionLastChangedAt: Date;
};

export type AcknowledgeBatch = {
  type: Transaction['type'];
  network: 'Preprod' | 'Mainnet';
  requests: AcknowledgeRequest[];
};

/**
 * Groups rows into request bodies for the acknowledge endpoints. Payments and
 * purchases go to different endpoints, and each request names one network, so
 * rows are grouped by both. A payment and its paired purchase can share a
 * blockchainIdentifier: they land in different groups, so both are sent.
 * Rows on an unsupported network are left out. Each request carries the
 * nextActionLastChangedAt the row was read with, so an error written after the
 * page loaded is not hidden.
 */
export function buildAcknowledgeBatches(
  transactions: Transaction[],
  contextNetwork: string | null | undefined,
): AcknowledgeBatch[] {
  const groups = new Map<string, AcknowledgeBatch>();
  for (const transaction of transactions) {
    const network = transaction.PaymentSource?.network ?? contextNetwork;
    if (network !== 'Preprod' && network !== 'Mainnet') continue;
    const key = `${transaction.type}:${network}`;
    const group = groups.get(key) ?? { type: transaction.type, network, requests: [] };
    if (!group.requests.some((r) => r.blockchainIdentifier === transaction.blockchainIdentifier)) {
      group.requests.push({
        blockchainIdentifier: transaction.blockchainIdentifier,
        // A Date or an ISO string, depending on whether the response was transformed.
        nextActionLastChangedAt: new Date(transaction.nextActionLastChangedAt),
      });
    }
    groups.set(key, group);
  }

  const batches: AcknowledgeBatch[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.requests.length; i += ACKNOWLEDGE_BATCH_SIZE) {
      batches.push({
        ...group,
        requests: group.requests.slice(i, i + ACKNOWLEDGE_BATCH_SIZE),
      });
    }
  }
  return batches;
}
