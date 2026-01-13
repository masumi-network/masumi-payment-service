/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, Search, RefreshCw } from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AddWalletDialog } from '@/components/wallets/AddWalletDialog';
//import { SwapDialog } from '@/components/wallets/SwapDialog';
import Link from 'next/link';
import { useAppContext } from '@/lib/contexts/AppContext';
import { Utxo } from '@/lib/api/generated';
import { Checkbox } from '@/components/ui/checkbox';
import { shortenAddress } from '@/lib/utils';
import Head from 'next/head';
import { useRate } from '@/lib/hooks/useRate';
import { WalletTableSkeleton } from '@/components/skeletons/WalletTableSkeleton';
import { Spinner } from '@/components/ui/spinner';
import { fetchWalletBalance, useWallets } from '@/lib/queries/useWallets';
import { useQueryClient } from '@tanstack/react-query';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import formatBalance from '@/lib/formatBalance';
import { Tabs } from '@/components/ui/tabs';
import {
  WalletDetailsDialog,
  WalletWithBalance as BaseWalletWithBalance,
} from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';
import { WalletTypeBadge } from '@/components/ui/wallet-type-badge';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';

type UTXO = Utxo;

interface WalletWithBalance extends BaseWalletWithBalance {
  network: 'Preprod' | 'Mainnet';
  collectionBalance?: {
    ada: string;
    usdm: string;
  } | null;
  isLoadingBalance?: boolean;
  isLoadingCollectionBalance?: boolean;
}

export default function WalletsPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState(
    typeof router.query.searched === 'string' ? router.query.searched : '',
  );
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedWallets, setSelectedWallets] = useState<string[]>([]);

  // Use React Query for cached wallet data
  const {
    wallets: walletsList,
    isLoading: isLoadingWallets,
    isFetching: isFetchingWallets,
    refetch: refetchWalletsQuery,
  } = useWallets();

  const [allWallets, setAllWallets] = useState<WalletWithBalance[]>([]);
  const [filteredWallets, setFilteredWallets] = useState<WalletWithBalance[]>(
    [],
  );

  const isLoading = isLoadingWallets && allWallets.length === 0;
  const [refreshingBalances, setRefreshingBalances] = useState<Set<string>>(
    new Set(),
  );
  const { apiClient, network, selectedPaymentSourceId } = useAppContext();
  const { rate } = useRate();
  const [selectedWalletForTopup, setSelectedWalletForTopup] =
    useState<WalletWithBalance | null>(null);
  const [activeTab, setActiveTab] = useState('All');
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);

  const tabs = [
    { name: 'All', count: null },
    { name: 'Purchasing', count: null },
    { name: 'Selling', count: null },
  ];

  // Initialize wallets from cached data and fetch collection balances
  useEffect(() => {
    if (walletsList && walletsList.length > 0) {
      const walletsWithCollections: WalletWithBalance[] = walletsList.map(
        (wallet) =>
          ({
            ...wallet,
            collectionBalance: null,
            isLoadingCollectionBalance: !!(wallet as any).collectionAddress,
          }) as WalletWithBalance,
      );
      setAllWallets(walletsWithCollections);

      // Fetch collection balances for wallets that have collection addresses
      walletsWithCollections.forEach(async (wallet) => {
        const collectionAddress = (wallet as any).collectionAddress;
        if (collectionAddress) {
          try {
            const collectionNetwork = wallet.network;
            const collectionBalance = await fetchWalletBalance(
              apiClient,
              collectionNetwork,
              collectionAddress,
            );
            setAllWallets((prev) =>
              prev.map((w) =>
                w.id === wallet.id
                  ? {
                      ...w,
                      collectionBalance: {
                        ada: collectionBalance.ada,
                        usdm: collectionBalance.usdm,
                      },
                      isLoadingCollectionBalance: false,
                    }
                  : w,
              ),
            );
          } catch (error) {
            console.error(
              `Failed to fetch collection balance for wallet ${wallet.id}:`,
              error,
            );
            setAllWallets((prev) =>
              prev.map((w) =>
                w.id === wallet.id
                  ? { ...w, isLoadingCollectionBalance: false }
                  : w,
              ),
            );
          }
        }
      });
    } else if (walletsList && walletsList.length === 0) {
      // Handle empty wallets array
      setAllWallets([]);
    }
  }, [apiClient, network, walletsList]);
  // Helper to refetch wallets (uses React Query refetch)
  const refetchWallets = useCallback(async () => {
    await refetchWalletsQuery();
  }, [refetchWalletsQuery]);

  // Initial load is handled by useWallets hook - no useEffect needed

  // Initialize searchQuery from router query parameter
  useEffect(() => {
    if (router.query.searched && typeof router.query.searched === 'string') {
      setSearchQuery(router.query.searched);
    }
  }, [router.query.searched]);

  // Handle action query parameter from search
  useEffect(() => {
    if (router.query.action === 'add_wallet') {
      setIsAddDialogOpen(true);
      // Clean up the query parameter
      router.replace('/wallets', undefined, { shallow: true });
    }
  }, [router.query.action, router]);

  const filterWallets = useCallback(() => {
    let filtered = [...allWallets];

    if (activeTab === 'Purchasing') {
      filtered = filtered.filter((wallet) => wallet.type === 'Purchasing');
    } else if (activeTab === 'Selling') {
      filtered = filtered.filter((wallet) => wallet.type === 'Selling');
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((wallet) => {
        const matchAddress =
          wallet.walletAddress?.toLowerCase().includes(query) ||
          (wallet as any).collectionAddress?.toLowerCase().includes(query) ||
          false;
        const matchNote =
          (wallet as any).note?.toLowerCase().includes(query) || false;
        const matchType = wallet.type?.toLowerCase().includes(query) || false;
        const matchBalance = wallet.balance
          ? (parseInt(wallet.balance) / 1000000 || 0).toFixed(2).includes(query)
          : false;
        const matchUsdmBalance = wallet.usdmBalance?.includes(query) || false;

        return (
          matchAddress ||
          matchNote ||
          matchType ||
          matchBalance ||
          matchUsdmBalance
        );
      });
    }

    setFilteredWallets(filtered);
  }, [allWallets, searchQuery, activeTab]);

  useEffect(() => {
    filterWallets();
  }, [allWallets, searchQuery, activeTab, filterWallets]);

  const handleSelectWallet = (id: string) => {
    setSelectedWallets((prev) =>
      prev.includes(id)
        ? prev.filter((walletId) => walletId !== id)
        : [...prev, id],
    );
  };

  const handleSelectAll = () => {
    if (filteredWallets.length === 0) {
      setSelectedWallets([]);
      return;
    }

    if (selectedWallets.length === filteredWallets.length) {
      setSelectedWallets([]);
    } else {
      setSelectedWallets(filteredWallets.map((wallet) => wallet.id));
    }
  };

  const refreshWalletBalance = useCallback(
    async (wallet: WalletWithBalance, isCollection: boolean = false) => {
      try {
        const walletId = isCollection ? `collection-${wallet.id}` : wallet.id;
        setRefreshingBalances((prev) => new Set(prev).add(walletId));
        const address = isCollection
          ? wallet.collectionAddress!
          : wallet.walletAddress;
        const walletNetwork = wallet.network;
        const balances = await fetchWalletBalance(
          apiClient,
          walletNetwork,
          address,
        );

        setFilteredWallets((prev) =>
          prev.map((w) => {
            if (w.id === wallet.id) {
              if (isCollection) {
                return {
                  ...w,
                  collectionBalance: {
                    ada: balances.ada,
                    usdm: balances.usdm,
                  },
                };
              }
              return {
                ...w,
                balance: balances.ada,
                usdmBalance: balances.usdm,
              };
            }
            return w;
          }),
        );
      } catch (error) {
        console.error('Error refreshing wallet balance:', error);
      } finally {
        const walletId = isCollection ? `collection-${wallet.id}` : wallet.id;
        setRefreshingBalances((prev) => {
          const newSet = new Set(prev);
          newSet.delete(walletId);
          return newSet;
        });
      }
    },
    [apiClient],
  );

  const handleWalletClick = (wallet: WalletWithBalance) => {
    setSelectedWalletForDetails(wallet);
  };

  return (
    <MainLayout>
      <Head>
        <title>Wallets | Admin Interface</title>
      </Head>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Wallets</h1>
            <p className="text-sm text-muted-foreground">
              Manage your buying and selling wallets.{' '}
              <Link
                href="https://docs.masumi.network/core-concepts/wallets"
                target="_blank"
                className="text-primary hover:underline"
              >
                Learn more
              </Link>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RefreshButton
              onRefresh={refetchWallets}
              isRefreshing={isFetchingWallets}
            />
            <Button
              className="flex items-center gap-2 bg-black text-white hover:bg-black/90"
              onClick={() => setIsAddDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
              Add wallet
            </Button>
          </div>
        </div>

        <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

        <div className="flex items-center justify-between gap-4">
          <div className="relative flex-1">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search by address, note, type, or balance..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="max-w-xs pl-10"
            />
          </div>
        </div>

        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b">
                <th className="w-12 p-4">
                  <Checkbox
                    checked={
                      filteredWallets.length > 0 &&
                      selectedWallets.length === filteredWallets.length
                    }
                    onCheckedChange={handleSelectAll}
                  />
                </th>
                <th className="p-4 text-left text-sm font-medium">Type</th>
                <th className="p-4 text-left text-sm font-medium">Note</th>
                <th className="p-4 text-left text-sm font-medium">Address</th>
                <th className="p-4 text-left text-sm font-medium">
                  Collection Address
                </th>
                <th className="p-4 text-left text-sm font-medium">
                  Balance, ADA
                </th>
                <th className="p-4 text-left text-sm font-medium">
                  Balance, USDM
                </th>
                <th className="w-20 p-4"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <WalletTableSkeleton rows={2} />
              ) : filteredWallets.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-8">
                    No wallets found
                  </td>
                </tr>
              ) : (
                <>
                  {filteredWallets.map((wallet) => (
                    <tr
                      key={wallet.id}
                      className="border-b last:border-b-0 hover:bg-muted/50 cursor-pointer"
                      onClick={() => handleWalletClick(wallet)}
                    >
                      <td className="p-4">
                        <Checkbox
                          checked={selectedWallets.includes(wallet.id)}
                          onCheckedChange={() => handleSelectWallet(wallet.id)}
                        />
                      </td>
                      <td className="p-4">
                        {wallet.type === 'Collection' ? (
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground">
                            Collection
                          </span>
                        ) : (
                          <WalletTypeBadge type={wallet.type} />
                        )}
                      </td>
                      <td className="p-4">
                        <div className="text-sm font-medium truncate">
                          {wallet.type === 'Purchasing'
                            ? 'Buying wallet'
                            : 'Selling wallet'}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {wallet.note || 'Created by seeding'}
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <span
                            className="font-mono text-sm"
                            title={wallet.walletAddress}
                          >
                            {shortenAddress(wallet.walletAddress)}
                          </span>
                          <CopyButton value={wallet.walletAddress} />
                        </div>
                      </td>
                      <td className="p-4">
                        {wallet.type === 'Selling' &&
                        wallet.collectionAddress ? (
                          <div className="flex items-center gap-2">
                            <span
                              className="font-mono text-sm"
                              title={wallet.collectionAddress}
                            >
                              {shortenAddress(wallet.collectionAddress)}
                            </span>
                            <CopyButton value={wallet.collectionAddress} />
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {wallet.type === 'Selling' ? 'Not set' : '—'}
                          </span>
                        )}
                      </td>
                      <td className="p-4">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            {refreshingBalances.has(wallet.id) ||
                            wallet.isLoadingBalance ? (
                              <Spinner size={16} />
                            ) : (
                              <span>
                                {wallet.balance
                                  ? formatBalance(
                                      (
                                        parseInt(wallet.balance) / 1000000
                                      ).toFixed(2),
                                    )
                                  : '0'}
                              </span>
                            )}
                          </div>
                          {!refreshingBalances.has(wallet.id) &&
                            !wallet.isLoadingBalance &&
                            wallet.balance &&
                            rate && (
                              <span className="text-xs text-muted-foreground">
                                $
                                {formatBalance(
                                  (
                                    (parseInt(wallet.balance) / 1000000) *
                                    rate
                                  ).toFixed(2),
                                ) || ''}
                              </span>
                            )}
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          {refreshingBalances.has(wallet.id) ||
                          wallet.isLoadingBalance ? (
                            <Spinner size={16} />
                          ) : (
                            <span>
                              {wallet.usdmBalance
                                ? `$${formatBalance((parseInt(wallet.usdmBalance) / 1000000).toFixed(2))}`
                                : '$0'}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={(e) => {
                              e.stopPropagation();
                              refreshWalletBalance(wallet);
                            }}
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                          {/*<Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedWalletForSwap(wallet as Wallet);
                            }}
                          >
                            <FaExchangeAlt className="h-4 w-4" />
                          </Button>*/}
                          <Button
                            variant="muted"
                            className="h-8"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedWalletForTopup(wallet);
                            }}
                          >
                            Top Up
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dialogs */}
      <AddWalletDialog
        open={isAddDialogOpen}
        onClose={() => setIsAddDialogOpen(false)}
        onSuccess={refetchWallets}
      />

      {/*<SwapDialog
        isOpen={!!selectedWalletForSwap}
        onClose={() => setSelectedWalletForSwap(null)}
        walletAddress={selectedWalletForSwap?.walletAddress || ''}
        network={state.network}
        blockfrostApiKey={process.env.NEXT_PUBLIC_BLOCKFROST_API_KEY || ''}
        walletType={selectedWalletForSwap?.type || ''}
        walletId={selectedWalletForSwap?.id || ''}
      />*/}

      <TransakWidget
        isOpen={!!selectedWalletForTopup}
        onClose={() => setSelectedWalletForTopup(null)}
        walletAddress={selectedWalletForTopup?.walletAddress || ''}
        onSuccess={refetchWallets}
      />

      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
      />
    </MainLayout>
  );
}
