import { PaymentSourceExtended } from '@/lib/api/generated';

export type PaymentSourceWalletDetails = {
  id: string;
  walletVkey: string;
  walletAddress: string;
  collectionAddress: string | null;
  note: string | null;
  type: 'Purchasing' | 'Selling';
  balance: string;
  usdmBalance: string;
};

export function listPaymentSourceWallets(
  paymentSources: readonly PaymentSourceExtended[],
): PaymentSourceWalletDetails[] {
  return paymentSources.flatMap((source) => [
    ...(source.SellingWallets ?? []).map((wallet) => ({
      ...wallet,
      type: 'Selling' as const,
      balance: '0',
      usdmBalance: '0',
    })),
    ...(source.PurchasingWallets ?? []).map((wallet) => ({
      ...wallet,
      type: 'Purchasing' as const,
      balance: '0',
      usdmBalance: '0',
    })),
  ]);
}

export function findPaymentSourceWalletByVkey(
  paymentSources: readonly PaymentSourceExtended[],
  walletVkey: string,
): PaymentSourceWalletDetails | null {
  return (
    listPaymentSourceWallets(paymentSources).find((wallet) => wallet.walletVkey === walletVkey) ??
    null
  );
}
