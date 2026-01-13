import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getUtxos, PaymentSource, Utxo } from '@/lib/api/generated';
import { Client } from '@hey-api/client-axios';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';
import { toast } from 'react-toastify';

type UTXO = Utxo;
type UTXOAmount = UTXO['Amounts'][0];

type Wallet =
  | (PaymentSource['PurchasingWallets'][0] & {
      type: 'Purchasing';
      network: 'Preprod' | 'Mainnet';
    })
  | (PaymentSource['SellingWallets'][0] & {
      type: 'Selling';
      network: 'Preprod' | 'Mainnet';
    });

export type WalletWithBalance = Wallet & {
  balance: string;
  usdmBalance: string;
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
    return { ada: '0', usdm: '0' };
  }
  if (responseData.error) {
    console.error('Error fetching wallet balance:', responseData.error);
    toast.error(
      'Error fetching wallet balance: ' + errorToString(responseData.error),
    );
    return { ada: '0', usdm: '0' };
  }

  if (!responseData.data?.data?.Utxos) {
    return { ada: '0', usdm: '0' };
  }

  try {
    let adaBalance = 0;
    let usdmBalance = 0;

    const usdmConfig = getUsdmConfig(network);

    responseData.data.data.Utxos.forEach((utxo: UTXO) => {
      utxo.Amounts.forEach((amount: UTXOAmount) => {
        if (amount.unit === 'lovelace' || amount.unit == '') {
          adaBalance += amount.quantity || 0;
        } else if (amount.unit === usdmConfig.fullAssetId) {
          usdmBalance += amount.quantity || 0;
        }
      });
    });

    return {
      ada: adaBalance.toString(),
      usdm: usdmBalance.toString(),
    };
  } catch (error) {
    console.error('Error processing wallet balance:', error);
    return { ada: '0', usdm: '0' };
  }
}

type WalletsResponse = {
  wallets: WalletWithBalance[];
  totalBalance: string;
  totalUsdmBalance: string;
  nextCursor?: string;
};

export function useWallets() {
  const { apiClient, selectedPaymentSourceId, selectedPaymentSource } =
    useAppContext();

  const query = useQuery<WalletsResponse>({
    queryKey: ['wallets', selectedPaymentSource, selectedPaymentSourceId],
    queryFn: async () => {
      if (!selectedPaymentSource) {
        return {
          wallets: [],
          totalBalance: '0',
          totalUsdmBalance: '0',
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
          totalUsdmBalance: '0',
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
      let totalUsdmBalance = 0;

      const walletsWithBalance: WalletWithBalance[] = allWallets.map(
        (wallet, index) => {
          const balance = balanceResults[index];
          const ada = parseInt(balance.ada || '0') || 0;
          const usdm = parseInt(balance.usdm || '0') || 0;

          totalAdaBalance += ada;
          totalUsdmBalance += usdm;

          return {
            ...wallet,
            balance: balance.ada,
            usdmBalance: balance.usdm,
            isLoadingBalance: false,
          };
        },
      );

      return {
        wallets: walletsWithBalance,
        totalBalance: totalAdaBalance.toString(),
        totalUsdmBalance: totalUsdmBalance.toString(),
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

  const totalUsdmBalance = useMemo(
    () => parseInt(query.data?.totalUsdmBalance || '0', 10) || 0,
    [query.data],
  );

  return {
    ...query,
    wallets,
    totalBalance: totalBalance.toString(),
    totalUsdmBalance: totalUsdmBalance.toString(),
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
