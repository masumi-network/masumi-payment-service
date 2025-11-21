/* eslint-disable react-hooks/rules-of-hooks */
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
import {
  getPaymentSource,
  GetPaymentSourceResponses,
  getUtxos,
  GetUtxosResponses,
  //getWallet,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { handleApiCall } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { cn, shortenAddress } from '@/lib/utils';
import Head from 'next/head';
import { useRate } from '@/lib/hooks/useRate';
import { Spinner } from '@/components/ui/spinner';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { FaExchangeAlt } from 'react-icons/fa';
import useFormatBalance from '@/lib/hooks/useFormatBalance';
import { Tabs } from '@/components/ui/tabs';
import {
  WalletDetailsDialog,
  WalletWithBalance as BaseWalletWithBalance,
} from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';
import { BadgeWithTooltip } from '@/components/ui/badge-with-tooltip';
import { TOOLTIP_TEXTS } from '@/lib/constants/tooltips';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';

type Wallet =
  | (GetPaymentSourceResponses['200']['data']['PaymentSources'][0]['PurchasingWallets'][0] & {
      type: 'Purchasing';
    })
  | (GetPaymentSourceResponses['200']['data']['PaymentSources'][0]['SellingWallets'][0] & {
      type: 'Selling';
    });

type UTXO = GetUtxosResponses['200']['data']['Utxos'][0];

interface WalletWithBalance extends BaseWalletWithBalance {
  collectionBalance?: {
    ada: string;
    usdm: string;
  } | null;
  isLoadingBalance?: boolean;
  isLoadingCollectionBalance?: boolean;
}

export default function WalletsPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedWallets, setSelectedWallets] = useState<string[]>([]);
  const [allWallets, setAllWallets] = useState<WalletWithBalance[]>([]);
  const [filteredWallets, setFilteredWallets] = useState<WalletWithBalance[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(true);
  const [refreshingBalances, setRefreshingBalances] = useState<Set<string>>(
    new Set(),
  );
  const { apiClient, state, selectedPaymentSourceId } = useAppContext();
  const { rate, isLoading: isLoadingRate } = useRate();
  const [selectedWalletForTopup, setSelectedWalletForTopup] =
    useState<Wallet | null>(null);
  const [selectedWalletForSwap, setSelectedWalletForSwap] =
    useState<Wallet | null>(null);
  const [activeTab, setActiveTab] = useState('All');
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);

  const tabs = [
    { name: 'All', count: null },
    { name: 'Purchasing', count: null },
    { name: 'Selling', count: null },
  ];

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
          wallet.collectionAddress?.toLowerCase().includes(query) ||
          false;
        const matchNote = wallet.note?.toLowerCase().includes(query) || false;
        const matchType = wallet.type?.toLowerCase().includes(query) || false;
        const matchBalance = wallet.balance
          ? (parseInt(wallet.balance) / 1000000).toFixed(2).includes(query)
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
  }, [filterWallets, searchQuery, activeTab]);

  const fetchWalletBalance = useCallback(
    async (address: string) => {
      const response = await handleApiCall(
        () =>
          getUtxos({
            client: apiClient,
            query: {
              address: address,
              network: state.network,
            },
          }),
        {
          onError: (error: any) => {
            console.error('Error fetching wallet balance:', error);
            if (error.message) {
              toast.error(error.message);
            }
          },
          errorMessage: 'Failed to fetch wallet balance',
        },
      );

      if (!response) return { ada: '0', usdm: '0' };

      if (response.data?.data?.Utxos) {
        let adaBalance = 0;
        let usdmBalance = 0;

        response.data.data.Utxos.forEach((utxo: UTXO) => {
          utxo.Amounts.forEach((amount) => {
            if (amount.unit === 'lovelace' || amount.unit == '') {
              adaBalance += amount.quantity || 0;
            } else if (
              amount.unit === getUsdmConfig(state.network).fullAssetId
            ) {
              usdmBalance += amount.quantity || 0;
            }
          });
        });

        return {
          ada: adaBalance.toString(),
          usdm: usdmBalance.toString(),
        };
      }
      return { ada: '0', usdm: '0' };
    },
    [apiClient, state.network],
  );

  const fetchWallets = useCallback(async () => {
    setIsLoading(true);
    const response = await handleApiCall(
      () => getPaymentSource({ client: apiClient }),
      {
        onError: (error: any) => {
          console.error('Error fetching wallets:', error);
          toast.error(error.message || 'Failed to load wallets');
        },
        onFinally: () => {
          setIsLoading(false);
        },
        errorMessage: 'Failed to load wallets',
      },
    );

    if (!response) return;

    if (response.data?.data?.PaymentSources) {
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

      if (paymentSources.length > 0) {
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

        // Display wallets immediately with loading states
        const initialWallets: WalletWithBalance[] = allWallets.map(
          (wallet: any) => ({
            id: wallet.id,
            walletVkey: wallet.walletVkey,
            walletAddress: wallet.walletAddress,
            note: wallet.note,
            type: wallet.type,
            balance: '0',
            usdmBalance: '0',
            collectionAddress: wallet.collectionAddress,
            collectionBalance: null,
            isLoadingBalance: true,
            isLoadingCollectionBalance: !!wallet.collectionAddress,
          }),
        );

        setAllWallets(initialWallets);
        setFilteredWallets(initialWallets);

        // Fetch balances progressively
        const updateWalletBalance = (
          walletId: string,
          updates: Partial<WalletWithBalance>,
        ) => {
          setAllWallets((prev) =>
            prev.map((w) => (w.id === walletId ? { ...w, ...updates } : w)),
          );
          setFilteredWallets((prev) =>
            prev.map((w) => (w.id === walletId ? { ...w, ...updates } : w)),
          );
        };

        // Fetch balances for each wallet
        allWallets.forEach(async (wallet: any) => {
          try {
            const balance = await fetchWalletBalance(wallet.walletAddress);
            updateWalletBalance(wallet.id, {
              balance: balance.ada,
              usdmBalance: balance.usdm,
              isLoadingBalance: false,
            });

            if (wallet.collectionAddress) {
              const collectionBalance = await fetchWalletBalance(
                wallet.collectionAddress,
              );
              updateWalletBalance(wallet.id, {
                collectionBalance: {
                  ada: collectionBalance.ada,
                  usdm: collectionBalance.usdm,
                },
                isLoadingCollectionBalance: false,
              });
            }
          } catch (error) {
            console.error(
              `Failed to fetch balance for wallet ${wallet.id}:`,
              error,
            );
            updateWalletBalance(wallet.id, {
              balance: '0',
              usdmBalance: '0',
              isLoadingBalance: false,
              isLoadingCollectionBalance: false,
            });
          }
        });
      } else {
        setAllWallets([]);
        setFilteredWallets([]);
      }
    }

    setIsLoading(false);
  }, [apiClient, fetchWalletBalance, selectedPaymentSourceId]);

  useEffect(() => {
    fetchWallets();
  }, [fetchWallets, state.network, selectedPaymentSourceId]);

  // Handle action query parameter from search
  useEffect(() => {
    if (router.query.action === 'add_wallet') {
      setIsAddDialogOpen(true);
      // Clean up the query parameter
      router.replace('/wallets', undefined, { shallow: true });
    }
  }, [router.query.action, router]);

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

  const refreshWalletBalance = async (
    wallet: WalletWithBalance,
    isCollection: boolean = false,
  ) => {
    try {
      const walletId = isCollection ? `collection-${wallet.id}` : wallet.id;
      setRefreshingBalances((prev) => new Set(prev).add(walletId));

      const address = isCollection
        ? wallet.collectionAddress!
        : wallet.walletAddress;
      const balances = await fetchWalletBalance(address);

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
  };

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
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">Wallets</h1>
              <BadgeWithTooltip
                text="?"
                tooltipText={TOOLTIP_TEXTS.WALLETS}
                variant="outline"
                className="text-xs w-5 h-5 rounded-full p-0 flex items-center justify-center cursor-help"
              />
            </div>
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
              onRefresh={() => fetchWallets()}
              isRefreshing={isLoading}
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
                <tr>
                  <td colSpan={8}>
                    <Spinner size={20} addContainer />
                  </td>
                </tr>
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
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                            wallet.type === 'Purchasing'
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-orange-50 dark:bg-[#f002] text-orange-600 dark:text-orange-400',
                          )}
                        >
                          {wallet.type === 'Purchasing' ? 'Buying' : 'Selling'}
                        </span>
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
                                  ? useFormatBalance(
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
                                {useFormatBalance(
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
                                ? `$${useFormatBalance((parseInt(wallet.usdmBalance) / 1000000).toFixed(2))}`
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
                              setSelectedWalletForTopup(wallet as Wallet);
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
        onSuccess={fetchWallets}
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
        onSuccess={fetchWallets}
      />

      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
      />
    </MainLayout>
  );
}
