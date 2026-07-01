import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { getUtxos, getWalletList, Utxo, UtxoAmount, WalletListItem } from '@/lib/api/generated';
import { Client } from '@/lib/api/generated/client';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getActiveStablecoinConfig } from '@/lib/constants/defaultWallets';
import { handleApiCall } from '@/lib/utils';
import {
  appendInclusiveCursorPage,
  flattenInclusiveCursorPages,
} from '@/lib/pagination/cursor-pagination';
import { toast } from 'react-toastify';

type UTXO = Utxo;
type UTXOAmount = UtxoAmount;

type Wallet = WalletListItem & {
  type: 'Purchasing' | 'Selling' | 'Funding';
  network: 'Preprod' | 'Mainnet';
};

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

  const network = selectedPaymentSource?.network;

  const query = useQuery<WalletsResponse>({
    queryKey: ['wallets', selectedPaymentSourceId, network],
    queryFn: async () => {
      if (!selectedPaymentSourceId || !network) {
        return {
          wallets: [],
          totalBalance: '0',
          totalUsdcxBalance: '0',
          nextCursor: undefined,
        };
      }

      // Hot wallets come from the dedicated /wallet/list endpoint (scoped to the
      // selected source), not from the payment-source response. The selected
      // source has a bounded wallet count, so we page through all of them here.
      let walletItems: WalletListItem[] = [];
      let cursor: string | undefined;
      while (true) {
        const response = await handleApiCall(
          () =>
            getWalletList({
              client: apiClient,
              query: { take: 50, cursorId: cursor, paymentSourceId: selectedPaymentSourceId },
            }),
          { errorMessage: 'Failed to load wallets' },
        );
        const page = response?.data?.data?.Wallets ?? [];
        if (page.length === 0) break;
        walletItems = appendInclusiveCursorPage(walletItems, page, (wallet) => wallet.id);
        if (page.length < 50) break;
        const lastWallet = page[page.length - 1];
        if (!lastWallet?.id || lastWallet.id === cursor) break;
        cursor = lastWallet.id;
      }

      if (walletItems.length === 0) {
        return {
          wallets: [],
          totalBalance: '0',
          totalUsdcxBalance: '0',
          nextCursor: undefined,
        };
      }

      const allWallets: Wallet[] = walletItems.map((wallet) => ({
        ...wallet,
        type: wallet.type,
        network,
      }));

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
    enabled: !!selectedPaymentSourceId && !!network,
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

const WALLET_PAGE_SIZE = 20;

/**
 * Resolves a set of wallets by their payment key hashes via `GET /wallet/list`,
 * one cached query per distinct vkey. Used where wallet metadata must be
 * resolved during render (e.g. transaction parties) without loading every
 * wallet up front. Returns a `vkey -> WalletListItem` map of the resolved ones.
 */
export function useWalletsByVkeys(walletVkeys: (string | null | undefined)[]) {
  const { apiClient } = useAppContext();

  const distinctVkeys = useMemo(
    () => Array.from(new Set(walletVkeys.filter((vkey): vkey is string => !!vkey))),
    [walletVkeys],
  );

  const results = useQueries({
    queries: distinctVkeys.map((vkey) => ({
      queryKey: ['wallet-by-vkey', vkey],
      queryFn: async () => {
        const response = await handleApiCall(
          () =>
            getWalletList({
              client: apiClient,
              query: { take: 1, walletVkey: vkey },
            }),
          { errorMessage: 'Failed to look up wallet' },
        );
        return response?.data?.data?.Wallets?.[0] ?? null;
      },
      enabled: !!apiClient && !!vkey,
      staleTime: 25000,
    })),
  });

  return useMemo(() => {
    const byVkey = new Map<string, WalletListItem>();
    results.forEach((result, index) => {
      if (result.data) {
        byVkey.set(distinctVkeys[index], result.data);
      }
    });
    return byVkey;
  }, [results, distinctVkeys]);
}

/**
 * Eagerly loads every wallet visible to the current key (all sources, no
 * balances), paginating /wallet/list. Used by global search and the api-key
 * scope pickers, which genuinely need the full set. Unlike the old
 * payment-source composition this only runs where it is actually consumed,
 * not on every page load.
 */
export function useAllWallets(enabled = true) {
  const { apiClient, apiKey } = useAppContext();

  const query = useQuery<WalletListItem[]>({
    queryKey: ['all-wallets', apiKey],
    queryFn: async () => {
      if (!apiKey) return [];
      let items: WalletListItem[] = [];
      let cursor: string | undefined;
      while (true) {
        const response = await handleApiCall(
          () => getWalletList({ client: apiClient, query: { take: 50, cursorId: cursor } }),
          { errorMessage: 'Failed to load wallets' },
        );
        const page = response?.data?.data?.Wallets ?? [];
        if (page.length === 0) break;
        items = appendInclusiveCursorPage(items, page, (wallet) => wallet.id);
        if (page.length < 50) break;
        const lastWallet = page[page.length - 1];
        if (!lastWallet?.id || lastWallet.id === cursor) break;
        cursor = lastWallet.id;
      }
      return items;
    },
    enabled: !!apiClient && !!apiKey && enabled,
    staleTime: 25000,
  });

  return {
    wallets: useMemo(() => query.data ?? [], [query.data]),
    isLoading: query.isLoading,
  };
}

/**
 * Eagerly loads every wallet for a single payment source (no balances). Used
 * where a bounded, complete per-source wallet set is needed for a source other
 * than the globally selected one (e.g. the V2 migration target).
 */
export function usePaymentSourceWalletsAll(paymentSourceId: string | null, enabled = true) {
  const { apiClient } = useAppContext();

  const query = useQuery<WalletListItem[]>({
    queryKey: ['payment-source-wallets-all', paymentSourceId],
    queryFn: async () => {
      if (!paymentSourceId) return [];
      let items: WalletListItem[] = [];
      let cursor: string | undefined;
      while (true) {
        const response = await handleApiCall(
          () =>
            getWalletList({
              client: apiClient,
              query: { take: 50, cursorId: cursor, paymentSourceId },
            }),
          { errorMessage: 'Failed to load wallets' },
        );
        const page = response?.data?.data?.Wallets ?? [];
        if (page.length === 0) break;
        items = appendInclusiveCursorPage(items, page, (wallet) => wallet.id);
        if (page.length < 50) break;
        const lastWallet = page[page.length - 1];
        if (!lastWallet?.id || lastWallet.id === cursor) break;
        cursor = lastWallet.id;
      }
      return items;
    },
    enabled: !!apiClient && !!paymentSourceId && enabled,
    staleTime: 25000,
  });

  return {
    wallets: useMemo(() => query.data ?? [], [query.data]),
    isLoading: query.isLoading,
  };
}

/**
 * Lean paginated wallet listing for an arbitrary payment source + type, without
 * balance lookups. Backs the per-source wallet sections in PaymentSourceDialog.
 * `enabled` lets callers defer the fetch until a collapsible section is opened.
 */
export function usePaymentSourceWalletList(args: {
  paymentSourceId: string | null;
  walletType: 'Selling' | 'Purchasing';
  enabled?: boolean;
}) {
  const { apiClient } = useAppContext();
  const { paymentSourceId, walletType, enabled = true } = args;

  const query = useInfiniteQuery({
    queryKey: ['payment-source-wallet-list', paymentSourceId, walletType],
    queryFn: async ({ pageParam }) => {
      if (!paymentSourceId) {
        return {
          wallets: [] as WalletListItem[],
          nextCursor: undefined as string | undefined,
          hasMore: false,
        };
      }

      const response = await handleApiCall(
        () =>
          getWalletList({
            client: apiClient,
            query: {
              take: WALLET_PAGE_SIZE,
              cursorId: pageParam ?? undefined,
              paymentSourceId,
              walletType,
            },
          }),
        { errorMessage: 'Failed to load wallets' },
      );

      const wallets = response?.data?.data?.Wallets ?? [];
      const hasMore = wallets.length === WALLET_PAGE_SIZE;
      const lastWallet = wallets[wallets.length - 1];
      const nextCursor = hasMore && lastWallet?.id ? lastWallet.id : undefined;

      return { wallets, nextCursor, hasMore };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: !!apiClient && !!paymentSourceId && enabled,
    staleTime: 25000,
  });

  const wallets = useMemo(
    () =>
      flattenInclusiveCursorPages(
        (query.data?.pages ?? []).map((page) => page.wallets),
        (wallet) => wallet.id,
      ),
    [query.data],
  );

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      query.fetchNextPage();
    }
  }, [query]);

  return {
    wallets,
    isLoading: query.isLoading,
    hasMore: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore,
  };
}

/**
 * Paginated wallet listing for the wallets management view. Backed by the
 * dedicated `GET /wallet/list` endpoint with cursor pagination + a "load more"
 * affordance, scoped to the currently selected payment source. Balances are
 * fetched per page as wallets are loaded.
 *
 * `walletType` maps to the page's type tab (omit for "All"). Unlike `useWallets`,
 * this does NOT eagerly load every wallet, so it must not be used where an
 * aggregate over all wallets is required (e.g. dashboard totals).
 */
export function usePaginatedWallets(walletType?: 'Selling' | 'Purchasing') {
  const { apiClient, selectedPaymentSourceId, selectedPaymentSource } = useAppContext();
  const network = selectedPaymentSource?.network;

  const query = useInfiniteQuery({
    queryKey: ['wallets-paginated', selectedPaymentSourceId, walletType],
    queryFn: async ({ pageParam }) => {
      if (!selectedPaymentSourceId || !network) {
        return {
          wallets: [] as WalletWithBalance[],
          nextCursor: undefined as string | undefined,
          hasMore: false,
        };
      }

      const response = await handleApiCall(
        () =>
          getWalletList({
            client: apiClient,
            query: {
              take: WALLET_PAGE_SIZE,
              cursorId: pageParam ?? undefined,
              paymentSourceId: selectedPaymentSourceId,
              walletType,
            },
          }),
        { errorMessage: 'Failed to load wallets' },
      );

      const items = response?.data?.data?.Wallets ?? [];
      const balances = await Promise.all(
        items.map((wallet) => fetchWalletBalance(apiClient, network, wallet.walletAddress)),
      );

      const wallets: WalletWithBalance[] = items.map((wallet, index) => ({
        ...wallet,
        type: wallet.type,
        network,
        balance: balances[index].ada,
        usdcxBalance: balances[index].usdcx,
        isLoadingBalance: false,
      }));

      const hasMore = items.length === WALLET_PAGE_SIZE;
      const lastWallet = items[items.length - 1];
      const nextCursor = hasMore && lastWallet?.id ? lastWallet.id : undefined;

      return { wallets, nextCursor, hasMore };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: !!apiClient && !!selectedPaymentSourceId,
    staleTime: 25000,
  });

  const wallets = useMemo(
    () =>
      flattenInclusiveCursorPages(
        (query.data?.pages ?? []).map((page) => page.wallets),
        (wallet) => wallet.id,
      ),
    [query.data],
  );

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      query.fetchNextPage();
    }
  }, [query]);

  return {
    wallets,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isRefetching: query.isRefetching,
    hasMore: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore,
    refetch: query.refetch,
  };
}
