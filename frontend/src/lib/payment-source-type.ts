import type { PaymentSource, PaymentSourceExtended } from '@/lib/api/generated';

export type PaymentSourceType = PaymentSource['paymentSourceType'];

export const DEFAULT_PAYMENT_SOURCE_TYPE: PaymentSourceType = 'Web3CardanoV2';

type PaymentSourceLike = Pick<PaymentSource | PaymentSourceExtended, 'paymentSourceType'> & {
  createdAt?: Date | string;
};

export function isV2PaymentSource(source: PaymentSourceLike | null | undefined): boolean {
  return source?.paymentSourceType === 'Web3CardanoV2';
}

export function getPaymentSourceTypeLabel(paymentSourceType: PaymentSourceType): string {
  return paymentSourceType === 'Web3CardanoV2' ? 'Web3 Cardano V2' : 'Web3 Cardano V1';
}

export function getPaymentSourceTypeShortLabel(paymentSourceType: PaymentSourceType): string {
  return paymentSourceType === 'Web3CardanoV2' ? 'V2' : 'V1';
}

export function getPaymentSourceTypeTone(
  paymentSourceType: PaymentSourceType,
): 'default' | 'legacy' {
  return paymentSourceType === DEFAULT_PAYMENT_SOURCE_TYPE ? 'default' : 'legacy';
}

export function sortPaymentSourcesByPreference<T extends PaymentSourceLike>(sources: T[]): T[] {
  return [...sources].sort((a, b) => {
    if (isV2PaymentSource(a) !== isV2PaymentSource(b)) {
      return isV2PaymentSource(a) ? -1 : 1;
    }

    const aCreatedAt = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bCreatedAt = b.createdAt ? new Date(b.createdAt).getTime() : 0;

    return bCreatedAt - aCreatedAt;
  });
}

export function getPreferredPaymentSource<T extends PaymentSourceLike>(sources: T[]): T | null {
  return sortPaymentSourcesByPreference(sources)[0] ?? null;
}

export function partitionPaymentSourcesByVersion<T extends PaymentSourceLike>(
  sources: T[],
): {
  v2Sources: T[];
  legacySources: T[];
} {
  const v2Sources: T[] = [];
  const legacySources: T[] = [];

  for (const source of sources) {
    if (isV2PaymentSource(source)) {
      v2Sources.push(source);
    } else {
      legacySources.push(source);
    }
  }

  return { v2Sources, legacySources };
}

export function hasLegacyOnlyPaymentSources<T extends PaymentSourceLike>(sources: T[]): boolean {
  const { v2Sources, legacySources } = partitionPaymentSourcesByVersion(sources);
  return legacySources.length > 0 && v2Sources.length === 0;
}

/**
 * Pick the payment source the admin UI should act on.
 *
 * V2 is preferred only once the Cardano V2 rail is actually ready. Until then,
 * keep operators on their working V1 source so agents, wallets, and transactions
 * stay visible while the migrate/setup banner nudges them forward.
 */
export function getOperationalPaymentSource<T extends PaymentSourceLike>(
  sources: T[],
  options?: { cardanoV2Ready?: boolean },
): T | null {
  if (sources.length === 0) {
    return null;
  }

  const { v2Sources, legacySources } = partitionPaymentSourcesByVersion(sources);
  const cardanoV2Ready = options?.cardanoV2Ready ?? false;

  if (legacySources.length > 0 && (v2Sources.length === 0 || !cardanoV2Ready)) {
    return getPreferredPaymentSource(legacySources);
  }

  return getPreferredPaymentSource(sources);
}
