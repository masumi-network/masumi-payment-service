import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getUtxos, Utxo, UtxoAmount, PurchasingWallet, SellingWallet } from '@/lib/api/generated';
import { Client } from '@/lib/api/generated/client';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getActiveStablecoinConfig } from '@/lib/constants/defaultWallets';
import { toast } from 'react-toastify';

type UTXO = Utxo;
type UTXOAmount = UtxoAmount;

type Wallet =
  | (PurchasingWallet & {
      type: 'Purchasing';
      network: 'Preprod' | 'Mainnet';
    })
  | (SellingWallet & {
      type: 'Selling';
      network: 'Preprod' | 'Mainnet';
    });

export type WalletWithBalance = Wallet & {
  balance: string;
  usdcxBalance: string;
  isLoadingBalance?: boolean;
};

export async function fetchWalletBalance(
  apiClient: Client,
  network: 'Preprod' | 'Mainnet',
  address: string,
) {
  const response = getUtxos({
    client: apiClient,
    query: {
      address: address,
      network: network,
    },
  });
  const responseData = await response;

  if (responseData.status == 404) {
    return { ada: '0', usdcx: '0' };
  }
  if (responseData.error) {
    console.error('Error fetching wallet balance:', responseData.error);
    toast.error('Error fetching wallet balance: ' + errorToString(responseData.error));
    return { ada: '0', usdcx: '0' };
  }

  if (!responseData.data?.data?.Utxos) {
    return { ada: '0', usdcx: '0' };
  }

  try {
    let adaBalance = 0;
    let usdcxBalance = 0;

    // Tracks only the active stablecoin for this network (USDCx on Mainnet, tUSDM on Preprod).
    // Legacy USDM tokens in Mainnet wallets are intentionally excluded from this summary;
    // they are still visible individually in WalletDetailsDialog.
    const stablecoinConfig = getActiveStablecoinConfig(network);

    responseData.data.data.Utxos.forEach((utxo: UTXO) => {
      utxo.Amounts.forEach((amount: UTXOAmount) => {
        if (amount.unit === 'lovelace' || amount.unit == '') {
          adaBalance += amount.quantity || 0;
        } else if (amount.unit === stablecoinConfig.fullAssetId) {
          usdcxBalance += amount.quantity || 0;
        }
      });
    });

    return {
      ada: adaBalance.toString(),
      usdcx: usdcxBalance.toString(),
    };
  } catch (error) {
    console.error('Error processing wallet balance:', error);
    return { ada: '0', usdcx: '0' };
  }
}

type WalletsResponse = {
  wallets: WalletWithBalance[];
  totalBalance: string;
  totalUsdcxBalance: string;
  nextCursor?: string;
};

export function useWallets() {
  const { apiClient, selectedPaymentSourceId, selectedPaymentSource } = useAppContext();

  const query = useQuery<WalletsResponse>({
    queryKey: ['wallets', selectedPaymentSource, selectedPaymentSourceId],
    queryFn: async () => {
      if (!selectedPaymentSource) {
        return {
          wallets: [],
          totalBalance: '0',
          totalUsdcxBalance: '0',
          nextCursor: undefined,
        };
      }
      const network = selectedPaymentSource.network;
      const purchasingWallets = selectedPaymentSource?.PurchasingWallets ?? [];
      const sellingWallets = selectedPaymentSource?.SellingWallets ?? [];

      if (purchasingWallets.length === 0 && sellingWallets.length === 0) {
        return {
          wallets: [],
          totalBalance: '0',
          totalUsdcxBalance: '0',
          nextCursor: undefined,
        };
      }

      const allWallets: Wallet[] = [
        ...purchasingWallets.map((wallet) => ({
          ...wallet,
          type: 'Purchasing' as const,
          network: network,
        })),
        ...sellingWallets.map((wallet) => ({
          ...wallet,
          type: 'Selling' as const,
          network: network,
        })),
      ];

      const balancePromises = allWallets.map((wallet) =>
        fetchWalletBalance(apiClient, wallet.network, wallet.walletAddress),
      );

      const balanceResults = await Promise.all(balancePromises);

      let totalAdaBalance = 0;
      let totalUsdcxBalance = 0;

      const walletsWithBalance: WalletWithBalance[] = allWallets.map((wallet, index) => {
        const balance = balanceResults[index];
        const ada = parseInt(balance.ada || '0') || 0;
        const usdcx = parseInt(balance.usdcx || '0') || 0;

        totalAdaBalance += ada;
        totalUsdcxBalance += usdcx;

        return {
          ...wallet,
          balance: balance.ada,
          usdcxBalance: balance.usdcx,
          isLoadingBalance: false,
        };
      });

      return {
        wallets: walletsWithBalance,
        totalBalance: totalAdaBalance.toString(),
        totalUsdcxBalance: totalUsdcxBalance.toString(),
        nextCursor: undefined,
      };
    },
    enabled: !!selectedPaymentSource && !!selectedPaymentSourceId,
    staleTime: 25000,
  });

  const wallets = useMemo(() => query.data?.wallets ?? [], [query.data]);

  const totalBalance = useMemo(
    () => parseInt(query.data?.totalBalance || '0', 10) || 0,
    [query.data],
  );

  const totalUsdcxBalance = useMemo(
    () => parseInt(query.data?.totalUsdcxBalance || '0', 10) || 0,
    [query.data],
  );

  return {
    ...query,
    wallets,
    totalBalance: totalBalance.toString(),
    totalUsdcxBalance: totalUsdcxBalance.toString(),
  };
}
function errorToString(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (error !== null && error !== undefined) {
    if (typeof error === 'object') {
      return JSON.stringify(error);
    }
  }
  return 'Unknown error';
}
