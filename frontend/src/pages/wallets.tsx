/* eslint-disable react-hooks/rules-of-hooks */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, Search, RefreshCw } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
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
}

export default function WalletsPage() {
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
  const [copiedAddresses, setCopiedAddresses] = useState<Set<string>>(
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
    { name: 'Collection', count: null },
  ];

  const filterWallets = useCallback(() => {
    let filtered = [...allWallets];

    if (activeTab === 'Purchasing') {
      filtered = filtered.filter((wallet) => wallet.type === 'Purchasing');
    } else if (activeTab === 'Selling') {
      filtered = filtered.filter((wallet) => wallet.type === 'Selling');
    } else if (activeTab === 'Collection') {
      filtered = filtered.filter((wallet) => wallet.collectionAddress);
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
      try {
        const response = await getUtxos({
          client: apiClient,
          query: {
            address: address,
            network: state.network,
          },
        });

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
      } catch (error) {
        console.error('Error fetching wallet balance:', error);
        return { ada: '0', usdm: '0' };
      }
    },
    [apiClient, state.network],
  );

  const fetchWallets = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await getPaymentSource({
        client: apiClient,
      });

      if (response.data?.data?.PaymentSources) {
        const paymentSources = response.data.data.PaymentSources.filter(
          (source) =>
            selectedPaymentSourceId
              ? source.id === selectedPaymentSourceId
              : true,
        );
        const purchasingWallets = paymentSources
          .map((source) => source.PurchasingWallets)
          .flat();
        const sellingWallets = paymentSources
          .map((source) => source.SellingWallets)
          .flat();

        if (paymentSources.length > 0) {
          const allWallets: Wallet[] = [
            ...purchasingWallets.map((wallet) => ({
              ...wallet,
              type: 'Purchasing' as const,
            })),
            ...sellingWallets.map((wallet) => ({
              ...wallet,
              type: 'Selling' as const,
            })),
          ];

          const walletsWithBalances = await Promise.all(
            allWallets.map(async (wallet) => {
              const balance = await fetchWalletBalance(wallet.walletAddress);
              let collectionBalance = null;

              if (wallet.collectionAddress) {
                collectionBalance = await fetchWalletBalance(
                  wallet.collectionAddress,
                );
              }

              const baseWallet: BaseWalletWithBalance = {
                id: wallet.id,
                walletVkey: wallet.walletVkey,
                walletAddress: wallet.walletAddress,
                note: wallet.note,
                type: wallet.type,
                balance: balance.ada,
                usdmBalance: balance.usdm,
                collectionAddress: wallet.collectionAddress,
              };

              return {
                ...baseWallet,
                collectionBalance: collectionBalance
                  ? {
                      ada: collectionBalance.ada,
                      usdm: collectionBalance.usdm,
                    }
                  : null,
              } as WalletWithBalance;
            }),
          );

          setAllWallets(walletsWithBalances);
          setFilteredWallets(walletsWithBalances);
        } else {
          setAllWallets([]);
          setFilteredWallets([]);
        }
      }
    } catch (error) {
      console.error('Error fetching wallets:', error);
      toast.error('Failed to load wallets');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, fetchWalletBalance, selectedPaymentSourceId]);

  useEffect(() => {
    fetchWallets();
  }, [fetchWallets, state.network, selectedPaymentSourceId]);

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

  const formatUsdValue = (adaAmount: string) => {
    if (!rate || !adaAmount) return '—';
    const ada = parseInt(adaAmount) / 1000000;
    return `≈ $${(ada * rate).toFixed(2)}`;
  };

  const hasSellingWallets = !isLoading
    ? allWallets.some((wallet) => wallet.type === 'Selling')
    : true;

  const handleWalletClick = (wallet: WalletWithBalance) => {
    setSelectedWalletForDetails(wallet);
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedAddresses((prev) => {
      const newSet = new Set(prev);
      newSet.add(`${id}-${text}`);
      return newSet;
    });
    setTimeout(() => {
      setCopiedAddresses((prev) => {
        const newSet = new Set(prev);
        newSet.delete(`${id}-${text}`);
        return newSet;
      });
    }, 2000);
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
                href="https://docs.masumi.network/technical-documentation/payment-service-api/wallets"
                target="_blank"
                className="text-primary hover:underline"
              >
                Learn more
              </Link>
            </p>
          </div>
          <Button
            className="flex items-center gap-2 bg-black text-white hover:bg-black/90"
            onClick={() => setIsAddDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Add wallet
          </Button>
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
                  <td colSpan={9}>
                    <Spinner size={20} addContainer />
                  </td>
                </tr>
              ) : filteredWallets.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center py-8">
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
                        {wallet.type === 'Selling' && wallet.collectionAddress ? (
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
                            {refreshingBalances.has(wallet.id) ? (
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
                          {refreshingBalances.has(wallet.id) ? (
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
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedWalletForSwap(wallet as Wallet);
                            }}
                          >
                            <FaExchangeAlt className="h-4 w-4" />
                          </Button>
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

                  {/* Collection Wallet Section */}
                  {filteredWallets.map((wallet) => {
                    if (!wallet.collectionAddress) return null;
                    return (
                      <tr
                        key={`collection-${wallet.id}`}
                        className="border-b last:border-b-0 hover:bg-muted/50 cursor-pointer"
                        onClick={() =>
                          handleWalletClick({
                            ...wallet,
                            walletAddress: wallet.collectionAddress!,
                            type: 'Collection' as any,
                            balance: wallet.collectionBalance?.ada || '0',
                            usdmBalance: wallet.collectionBalance?.usdm || '0',
                          })
                        }
                      >
                        <td className="p-4">
                          <Checkbox
                            checked={selectedWallets.includes(
                              `collection-${wallet.id}`,
                            )}
                            onCheckedChange={() =>
                              handleSelectWallet(`collection-${wallet.id}`)
                            }
                          />
                        </td>
                        <td className="p-4">
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-blue-500/20 text-blue-600 dark:text-blue-400">
                            Collection
                          </span>
                        </td>
                        <td className="p-4">
                          <div className="text-sm font-medium truncate">
                            Collection wallet
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {wallet.note || 'Created by seeding'}
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            <span
                              className="font-mono text-sm"
                              title={wallet.collectionAddress}
                            >
                              {shortenAddress(wallet.collectionAddress!)}
                            </span>
                            <CopyButton value={wallet.collectionAddress!} />
                          </div>
                        </td>
                        <td className="p-4">
                          <span className="text-xs text-muted-foreground">—</span>
                        </td>
                        <td className="p-4">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              {refreshingBalances.has(
                                `collection-${wallet.id}`,
                              ) ? (
                                <Spinner size={16} />
                              ) : (
                                <span>
                                  {wallet.collectionBalance?.ada
                                    ? `${useFormatBalance((parseInt(wallet.collectionBalance.ada) / 1000000).toFixed(2))}`
                                    : '0'}
                                </span>
                              )}
                            </div>
                            {!refreshingBalances.has(
                              `collection-${wallet.id}`,
                            ) &&
                              wallet.collectionBalance?.ada &&
                              rate && (
                                <span className="text-xs text-muted-foreground">
                                  $
                                  {useFormatBalance(
                                    (
                                      (parseInt(wallet.collectionBalance.ada) /
                                        1000000) *
                                      rate
                                    ).toFixed(2),
                                  )}
                                </span>
                              )}
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            {refreshingBalances.has(
                              `collection-${wallet.id}`,
                            ) ? (
                              <Spinner size={16} />
                            ) : (
                              <span>
                                {wallet.collectionBalance?.usdm
                                  ? `$${useFormatBalance((parseInt(wallet.collectionBalance.usdm) / 1000000).toFixed(2))}`
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
                                refreshWalletBalance(wallet, true);
                              }}
                            >
                              <RefreshCw className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
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
