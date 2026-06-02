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
