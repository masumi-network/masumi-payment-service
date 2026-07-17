import { Button } from '@/components/ui/button';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, ArrowLeftRight, PlusCircle, AlertTriangle, Send } from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { AddWalletDialog } from '@/components/wallets/AddWalletDialog';
import { SwapDialog } from '@/components/wallets/SwapDialog';
import { TransferFundsDialog } from '@/components/wallets/TransferFundsDialog';
import Link from 'next/link';
import { useAppContext } from '@/lib/contexts/AppContext';

import { formatSixDecimalAmount, shortenAddress } from '@/lib/utils';
import Head from 'next/head';
import { useRate } from '@/lib/hooks/useRate';
import { WalletTableSkeleton } from '@/components/skeletons/WalletTableSkeleton';
import { Spinner } from '@/components/ui/spinner';
import { usePaginatedWallets } from '@/lib/queries/useWallets';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import formatBalance from '@/lib/formatBalance';
import { Tabs } from '@/components/ui/tabs';
import {
  WalletDetailsDialog,
  WalletWithBalance as BaseWalletWithBalance,
} from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Badge } from '@/components/ui/badge';
import { WalletTypeBadge } from '@/components/ui/wallet-type-badge';
import { AnimatedPage } from '@/components/ui/animated-page';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';

interface WalletWithBalance extends BaseWalletWithBalance {
  network: 'Preprod' | 'Mainnet';
  isLoadingBalance?: boolean;
  /** True when the balance fetch failed — render "—", not 0. */
  isBalanceUnavailable?: boolean;
}

export default function WalletsPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState(
    typeof router.query.searched === 'string' ? router.query.searched : '',
  );
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('All');

  // The type tab is applied server-side so each tab paginates independently.
  const walletTypeFilter =
    activeTab === 'Purchasing' ? 'Purchasing' : activeTab === 'Selling' ? 'Selling' : undefined;

  // Paginated wallet data for the selected payment source (cursor + load-more).
  const {
    wallets: walletsList,
    isLoading: isLoadingWallets,
    isFetching: isFetchingWallets,
    isFetchingNextPage,
    hasMore,
    loadMore,
    refetch: refetchWalletsQuery,
  } = usePaginatedWallets(walletTypeFilter);

  // State-based previous value tracking for router query initialization
  // (React-recommended pattern: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  const routerSearched = typeof router.query.searched === 'string' ? router.query.searched : '';
  const [prevRouterSearched, setPrevRouterSearched] = useState(routerSearched);

  const { network, selectedPaymentSource } = useAppContext();
  const { rate } = useRate();
  const [selectedWalletForTopup, setSelectedWalletForTopup] = useState<WalletWithBalance | null>(
    null,
  );
  const [selectedWalletForSwap, setSelectedWalletForSwap] = useState<WalletWithBalance | null>(
    null,
  );
  const [selectedWalletForTransfer, setSelectedWalletForTransfer] =
    useState<WalletWithBalance | null>(null);
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);

  const tabs = [
    { name: 'All', count: null },
    { name: 'Purchasing', count: null },
    { name: 'Selling', count: null },
  ];

  const allWallets = walletsList as WalletWithBalance[];

  // Also treat "payment source still resolving" as loading so the table shows a
  // skeleton instead of flashing an empty state before the source-gated query
  // can start (mirrors the dashboard fix).
  const isLoading = (isLoadingWallets || !selectedPaymentSource) && allWallets.length === 0;

  const queryClient = useQueryClient();

  // Passive refresh (refresh button, top-up balance change): keep the current
  // rows and refetch in the background.
  const refetchWallets = useCallback(async () => {
    await refetchWalletsQuery();
  }, [refetchWalletsQuery]);

  // Adding a wallet changes list membership, so clear the paginated list to its
  // skeleton while the fresh page loads; the dashboard aggregate refetches in
  // place (invalidate, not reset).
  const refetchAfterWalletAdded = useCallback(() => {
    void queryClient.resetQueries({ queryKey: ['wallets-paginated'] });
    void queryClient.invalidateQueries({ queryKey: ['wallets'] });
  }, [queryClient]);

  // Adjust state during render when router query changes
  if (routerSearched !== prevRouterSearched) {
    setPrevRouterSearched(routerSearched);
    if (routerSearched) {
      setSearchQuery(routerSearched);
    }
  }

  // Open the add-wallet dialog when the ?action=add_wallet deep link arrives,
  // then strip the param so the same quick action can fire again while
  // already on this page.
  useEffect(() => {
    if (router.isReady && router.query.action === 'add_wallet') {
      queueMicrotask(() => setIsAddDialogOpen(true));
      void router.replace('/wallets', undefined, { shallow: true });
    }
  }, [router.isReady, router.query.action, router]);

  const filteredWallets = useMemo(() => {
    let filtered = [...allWallets];

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((wallet) => {
        const matchAddress =
          wallet.walletAddress?.toLowerCase().includes(query) ||
          wallet.collectionAddress?.toLowerCase().includes(query) ||
          false;
        const matchNote = wallet.note?.toLowerCase().includes(query) || false;
        const matchType = wallet.type?.toLowerCase().includes(query) || false;
        const matchBalance = wallet.balance
          ? (parseInt(wallet.balance) / 1000000 || 0).toFixed(2).includes(query)
          : false;
        const matchUsdcxBalance = wallet.usdcxBalance?.includes(query) || false;

        return matchAddress || matchNote || matchType || matchBalance || matchUsdcxBalance;
      });
    }

    return filtered;
  }, [allWallets, searchQuery]);

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
                  rel="noopener noreferrer"
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
                    Balance, {network === 'Mainnet' ? 'USDCx' : 'tUSDM'}
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
                        className={`border-b last:border-b-0 cursor-pointer animate-fade-in opacity-0 transition-[background-color,opacity] duration-150 ${
                          wallet.LowBalanceSummary?.isLow
                            ? 'bg-amber-500/5 hover:bg-amber-500/10'
                            : 'hover:bg-muted/50'
                        }`}
                        style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                        onClick={() => handleWalletClick(wallet)}
                      >
                        <td className="p-4 pl-6">
                          <div className="flex flex-col gap-2">
                            {wallet.type === 'Collection' ? (
                              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground">
                                Collection
                              </span>
                            ) : (
                              <WalletTypeBadge type={wallet.type} />
                            )}
                            {wallet.LowBalanceSummary?.isLow && (
                              <Badge variant="destructive" className="w-fit gap-1">
                                <AlertTriangle className="h-3 w-3" />
                                {wallet.LowBalanceSummary.lowRuleCount} low
                              </Badge>
                            )}
                          </div>
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
                                  {wallet.isBalanceUnavailable
                                    ? '—'
                                    : formatSixDecimalAmount(wallet.balance || '0')}
                                </span>
                              )}
                            </div>
                            {!wallet.isLoadingBalance &&
                              !wallet.isBalanceUnavailable &&
                              wallet.balance &&
                              rate && (
                                <span className="text-xs text-muted-foreground">
                                  $
                                  {formatBalance(
                                    ((Number(wallet.balance) / 1000000) * rate).toFixed(2),
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
                                {wallet.isBalanceUnavailable
                                  ? '—'
                                  : `$${formatSixDecimalAmount(wallet.usdcxBalance || '0')}`}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-4 pr-8">
                          <div className="flex items-center gap-2">
                            {wallet.network === 'Mainnet' && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Swap tokens"
                                className="h-8 w-8"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedWalletForSwap(wallet);
                                }}
                              >
                                <ArrowLeftRight className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Transfer funds"
                              className="h-8 w-8"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedWalletForTransfer(wallet);
                              }}
                            >
                              <Send className="h-4 w-4" />
                            </Button>
                            <Button
                              className="h-8"
                              variant="muted"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedWalletForTopup(wallet);
                              }}
                            >
                              <PlusCircle className="h-3.5 w-3.5" />
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

          {hasMore && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={loadMore} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>

        {/* Dialogs */}
        <AddWalletDialog
          open={isAddDialogOpen}
          onClose={() => setIsAddDialogOpen(false)}
          onSuccess={refetchAfterWalletAdded}
        />

        <SwapDialog
          isOpen={!!selectedWalletForSwap}
          onClose={() => setSelectedWalletForSwap(null)}
          walletAddress={selectedWalletForSwap?.walletAddress || ''}
          walletVkey={selectedWalletForSwap?.walletVkey || ''}
          network={network}
        />

        <TransferFundsDialog
          isOpen={!!selectedWalletForTransfer}
          onClose={() => setSelectedWalletForTransfer(null)}
          walletAddress={selectedWalletForTransfer?.walletAddress || ''}
          network={network}
          onSuccess={refetchWallets}
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
