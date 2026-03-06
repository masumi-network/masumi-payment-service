import { Button } from '@/components/ui/button';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus } from 'lucide-react';
import { FaExchangeAlt } from 'react-icons/fa';
import { RefreshButton } from '@/components/RefreshButton';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import { AddWalletDialog } from '@/components/wallets/AddWalletDialog';
import { SwapDialog } from '@/components/wallets/SwapDialog';
import Link from 'next/link';
import { useAppContext } from '@/lib/contexts/AppContext';
import { Utxo } from '@/lib/api/generated';

import { shortenAddress } from '@/lib/utils';
import Head from 'next/head';
import { useRate } from '@/lib/hooks/useRate';
import { WalletTableSkeleton } from '@/components/skeletons/WalletTableSkeleton';
import { Spinner } from '@/components/ui/spinner';
import { fetchWalletBalance, useWallets } from '@/lib/queries/useWallets';
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
import { AnimatedPage } from '@/components/ui/animated-page';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';

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

  // Use React Query for cached wallet data
  const {
    wallets: walletsList,
    isLoading: isLoadingWallets,
    isFetching: isFetchingWallets,
    refetch: refetchWalletsQuery,
  } = useWallets();

  const [allWallets, setAllWallets] = useState<WalletWithBalance[]>([]);

  const isLoading = isLoadingWallets && allWallets.length === 0;
  const { apiClient, network, selectedPaymentSourceId } = useAppContext();
  const { rate } = useRate();
  const [selectedWalletForTopup, setSelectedWalletForTopup] = useState<WalletWithBalance | null>(
    null,
  );
  const [selectedWalletForSwap, setSelectedWalletForSwap] = useState<WalletWithBalance | null>(
    null,
  );
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
    if (!walletsList) return;

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
          console.error(`Failed to fetch collection balance for wallet ${wallet.id}:`, error);
          setAllWallets((prev) =>
            prev.map((w) =>
              w.id === wallet.id ? { ...w, isLoadingCollectionBalance: false } : w,
            ),
          );
        }
      }
    });
  }, [apiClient, network, walletsList]);
  // Helper to refetch wallets (uses React Query refetch)
  const refetchWallets = useCallback(async () => {
    await refetchWalletsQuery();
  }, [refetchWalletsQuery]);

  // Initial load is handled by useWallets hook - no useEffect needed

  // Initialize searchQuery from router query parameter (only on first load)
  useEffect(() => {
    if (!router.isReady) return;

    if (router.query.searched && typeof router.query.searched === 'string') {
      setSearchQuery(router.query.searched);
    }
  }, [router.isReady]);

  // Handle action query parameter from search
  useEffect(() => {
    if (!router.isReady) return;

    if (router.query.action === 'add_wallet') {
      setIsAddDialogOpen(true);
      // Clean up the query parameter
      router.replace('/wallets', undefined, { shallow: true });
    }
  }, [router.isReady, router]);

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
        const matchNote = (wallet as any).note?.toLowerCase().includes(query) || false;
        const matchType = wallet.type?.toLowerCase().includes(query) || false;
        const matchBalance = wallet.balance
          ? (parseInt(wallet.balance) / 1000000 || 0).toFixed(2).includes(query)
          : false;
        const matchUsdmBalance = wallet.usdmBalance?.includes(query) || false;

        return matchAddress || matchNote || matchType || matchBalance || matchUsdmBalance;
      });
    }

    setFilteredWallets(filtered);
  }, [allWallets, searchQuery, activeTab]);

  useEffect(() => {
    filterWallets();
  }, [allWallets, searchQuery, activeTab]);

  const handleWalletClick = (wallet: WalletWithBalance) => {
    setSelectedWalletForDetails(wallet);
  };

  return (
    <MainLayout>
      <Head>
        <title>Wallets | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Wallets</h1>
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
              <RefreshButton onRefresh={refetchWallets} isRefreshing={isFetchingWallets} />
              <Button
                className="flex items-center gap-2 btn-hover-lift"
                onClick={() => setIsAddDialogOpen(true)}
              >
                <Plus className="h-4 w-4" />
                Add wallet
              </Button>
            </div>
          </div>

          <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search by address, note, type, or balance..."
                className="max-w-xs"
              />
            </div>
          </div>

          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/30 dark:bg-muted/15">
                <tr className="border-b">
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground pl-6">
                    Type
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">Note</th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Address
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Collection Address
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Balance, ADA
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Balance, USDM
                  </th>
                  <th className="w-20 p-4 pr-8"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <WalletTableSkeleton rows={2} />
                ) : filteredWallets.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <EmptyState
                        icon="inbox"
                        title="No wallets found"
                        description="Add a wallet to get started"
                      />
                    </td>
                  </tr>
                ) : (
                  <>
                    {filteredWallets.map((wallet, index) => (
                      <tr
                        key={wallet.id}
                        className="border-b last:border-b-0 hover:bg-muted/50 cursor-pointer animate-fade-in opacity-0 transition-[background-color,opacity] duration-150"
                        style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                        onClick={() => handleWalletClick(wallet)}
                      >
                        <td className="p-4 pl-6">
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
                            {wallet.type === 'Purchasing' ? 'Buying wallet' : 'Selling wallet'}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {wallet.note || 'Created by seeding'}
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm" title={wallet.walletAddress}>
                              {shortenAddress(wallet.walletAddress)}
                            </span>
                            <CopyButton value={wallet.walletAddress} />
                          </div>
                        </td>
                        <td className="p-4">
                          {wallet.type === 'Selling' && wallet.collectionAddress ? (
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm" title={wallet.collectionAddress}>
                                {shortenAddress(wallet.collectionAddress)}
                              </span>
                              <CopyButton value={wallet.collectionAddress} />
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground/50">{'\u2014'}</span>
                          )}
                        </td>
                        <td className="p-4">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              {wallet.isLoadingBalance ? (
                                <Spinner size={16} />
                              ) : (
                                <span>
                                  {wallet.balance
                                    ? formatBalance((parseInt(wallet.balance) / 1000000).toFixed(2))
                                    : '0'}
                                </span>
                              )}
                            </div>
                            {!wallet.isLoadingBalance && wallet.balance && rate && (
                              <span className="text-xs text-muted-foreground">
                                $
                                {formatBalance(
                                  ((parseInt(wallet.balance) / 1000000) * rate).toFixed(2),
                                ) || ''}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            {wallet.isLoadingBalance ? (
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
                        <td className="p-4 pr-8">
                          <div className="flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedWalletForSwap(wallet);
                              }}
                            >
                              <FaExchangeAlt className="h-4 w-4" />
                            </Button>
                            <Button
                              className="h-8"
                              variant="muted"
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

        <SwapDialog
          isOpen={!!selectedWalletForSwap}
          onClose={() => setSelectedWalletForSwap(null)}
          walletAddress={selectedWalletForSwap?.walletAddress || ''}
          walletVkey={selectedWalletForSwap?.walletVkey || ''}
          network={network}
        />

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
      </AnimatedPage>
    </MainLayout>
  );
}
