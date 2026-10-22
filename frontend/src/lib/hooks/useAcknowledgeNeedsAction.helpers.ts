import type { Transaction } from '@/components/transactions/transaction-format.helpers';

/** Matches the backend limit on /payment|purchase/acknowledge-manual-action. */
export const ACKNOWLEDGE_BATCH_SIZE = 100;

export type AcknowledgeBatch = {
  type: Transaction['type'];
  network: 'Preprod' | 'Mainnet';
  blockchainIdentifiers: string[];
};

/**
 * Groups rows into request bodies for the acknowledge endpoints. Payments and
 * purchases go to different endpoints, and each request names one network, so
 * rows are grouped by both. A payment and its paired purchase can share a
 * blockchainIdentifier: they land in different groups, so both are sent.
 * Rows on an unsupported network are left out.
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
    const group = groups.get(key) ?? { type: transaction.type, network, blockchainIdentifiers: [] };
    if (!group.blockchainIdentifiers.includes(transaction.blockchainIdentifier)) {
      group.blockchainIdentifiers.push(transaction.blockchainIdentifier);
    }
    groups.set(key, group);
  }

  const batches: AcknowledgeBatch[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.blockchainIdentifiers.length; i += ACKNOWLEDGE_BATCH_SIZE) {
      batches.push({
        ...group,
        blockchainIdentifiers: group.blockchainIdentifiers.slice(i, i + ACKNOWLEDGE_BATCH_SIZE),
      });
    }
  }
  return batches;
}
