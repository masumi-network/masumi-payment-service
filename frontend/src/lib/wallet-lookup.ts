import { getWalletList, type WalletListItem } from '@/lib/api/generated';
import type { Client } from '@/lib/api/generated/client';
import { handleApiCall } from '@/lib/utils';

export type PaymentSourceWalletDetails = {
  id: string;
  walletVkey: string;
  walletAddress: string;
  collectionAddress: string | null;
  note: string | null;
  type: 'Purchasing' | 'Selling' | 'Funding';
  balance: string;
  usdcxBalance: string;
};

export function toPaymentSourceWalletDetails(wallet: WalletListItem): PaymentSourceWalletDetails {
  return {
    id: wallet.id,
    walletVkey: wallet.walletVkey,
    walletAddress: wallet.walletAddress,
    collectionAddress: wallet.collectionAddress,
    note: wallet.note,
    type: wallet.type,
    balance: '0',
    usdcxBalance: '0',
  };
}

/**
 * Resolves a single wallet by its payment key hash via the dedicated
 * `GET /wallet/list?walletVkey=` endpoint instead of scanning an eagerly-loaded
 * set of every wallet. Optionally scope to a payment source. Returns null when
 * no matching wallet exists.
 */
export async function lookupWalletByVkey(args: {
  apiClient: Client;
  walletVkey: string;
  paymentSourceId?: string | null;
}): Promise<PaymentSourceWalletDetails | null> {
  const response = await handleApiCall(
    () =>
      getWalletList({
        client: args.apiClient,
        query: {
          take: 1,
          walletVkey: args.walletVkey,
          paymentSourceId: args.paymentSourceId ?? undefined,
        },
      }),
    { errorMessage: 'Failed to look up wallet' },
  );

  const wallet = response?.data?.data?.Wallets?.[0];
  return wallet ? toPaymentSourceWalletDetails(wallet) : null;
}
