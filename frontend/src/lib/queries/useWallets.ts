import { useQuery } from '@tanstack/react-query';
import { getPaymentSource, getUtxos } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';

type Wallet =
  | (Awaited<
      ReturnType<typeof getPaymentSource>
    >['data']['data']['PaymentSources'][0]['PurchasingWallets'][0] & {
      type: 'Purchasing';
    })
  | (Awaited<
      ReturnType<typeof getPaymentSource>
    >['data']['data']['PaymentSources'][0]['SellingWallets'][0] & {
      type: 'Selling';
    });

export type WalletWithBalance = Wallet & {
  balance: string;
  usdmBalance: string;
  isLoadingBalance?: boolean;
};

async function fetchWalletBalance(
  apiClient: any,
  network: string,
  address: string,
) {
  const response = await handleApiCall(
    () =>
      getUtxos({
        client: apiClient,
        query: {
          address: address,
          network: network,
        },
      }),
    {
      errorMessage: 'Error fetching wallet balance',
    },
  );

  if (!response?.data?.data?.Utxos) {
    return { ada: '0', usdm: '0' };
  }

  try {
    let adaBalance = 0;
    let usdmBalance = 0;

    const usdmConfig = getUsdmConfig(network);

    response.data.data.Utxos.forEach((utxo: any) => {
      utxo.Amounts.forEach((amount: any) => {
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

export function useWallets() {
  const { apiClient, state, selectedPaymentSourceId } = useAppContext();

  return useQuery({
    queryKey: ['wallets', state.network, selectedPaymentSourceId],
    queryFn: async () => {
      const response = await handleApiCall(
        () => getPaymentSource({ client: apiClient }),
        {
          errorMessage: 'Failed to load wallets',
        },
      );

      if (!response?.data?.data?.PaymentSources) {
        return {
          wallets: [],
          totalBalance: '0',
          totalUsdmBalance: '0',
        };
      }

      const paymentSources = response.data.data.PaymentSources.filter(
        (source: any) =>
          selectedPaymentSourceId
            ? source.id === selectedPaymentSourceId
            : true,
      );

      const purchasingWallets = paymentSources
        .map((source: any) => source.PurchasingWallets)
        .flat();
      const sellingWallets = paymentSources
        .map((source: any) => source.SellingWallets)
        .flat();

      if (paymentSources.length === 0) {
        return {
          wallets: [],
          totalBalance: '0',
          totalUsdmBalance: '0',
        };
      }

      const allWallets: Wallet[] = [
        ...purchasingWallets.map((wallet: any) => ({
          ...wallet,
          type: 'Purchasing' as const,
        })),
        ...sellingWallets.map((wallet: any) => ({
          ...wallet,
          type: 'Selling' as const,
        })),
      ];

      // Fetch balances for all wallets concurrently
      const balancePromises = allWallets.map((wallet) =>
        fetchWalletBalance(apiClient, state.network, wallet.walletAddress),
      );

      const balanceResults = await Promise.all(balancePromises);

      // Calculate totals and create wallets with balances
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
      };
    },
    enabled:
      !!state.paymentSources &&
      state.paymentSources.length > 0 &&
      !!selectedPaymentSourceId,
    staleTime: 60 * 1000, // 60 seconds
  });
}
