/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable react-hooks/rules-of-hooks */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, Copy, Search, RefreshCw } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { AddWalletDialog } from '@/components/wallets/AddWalletDialog';
import { SwapDialog } from '@/components/wallets/SwapDialog';
import Link from 'next/link';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getPaymentSource, getUtxos } from '@/lib/api/generated';
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

interface Wallet {
  id: string;
  walletVkey: string;
  walletAddress: string;
  collectionAddress: string | null;
  note: string | null;
  type: 'Purchasing' | 'Selling';
  balance?: string;
  usdmBalance?: string;
}

interface UTXO {
  txHash: string;
  address: string;
  Amounts: Array<{
    unit: string;
    quantity: number | null;
  }>;
  dataHash: string | null;
  inlineDatum: string | null;
  referenceScriptHash: string | null;
  outputIndex: number | null;
  block: string;
}

export default function WalletsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedWallets, setSelectedWallets] = useState<string[]>([]);
  const [allWallets, setAllWallets] = useState<Wallet[]>([]);
  const [filteredWallets, setFilteredWallets] = useState<Wallet[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshingBalances, setRefreshingBalances] = useState<Set<string>>(
    new Set(),
  );
  const { apiClient, state } = useAppContext();
  const { rate, isLoading: isLoadingRate } = useRate();
  const [selectedWalletForTopup, setSelectedWalletForTopup] =
    useState<Wallet | null>(null);
  const [selectedWalletForSwap, setSelectedWalletForSwap] =
    useState<Wallet | null>(null);
  const [activeTab, setActiveTab] = useState('All');

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
          wallet.walletAddress?.toLowerCase().includes(query) || false;
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

  const fetchWalletBalance = async (wallet: Wallet) => {
    try {
      const response = await getUtxos({
        client: apiClient,
        query: {
          address: wallet.walletAddress,
          network: state.network,
        },
      });

      if (response.data?.data?.Utxos) {
        let adaBalance = 0;
        let usdmBalance = 0;

        response.data.data.Utxos.forEach((utxo: UTXO) => {
          utxo.Amounts.forEach((amount) => {
            if (amount.unit === 'lovelace') {
              adaBalance += amount.quantity || 0;
            } else if (amount.unit === 'USDM') {
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
  };

  const fetchWallets = async () => {
    try {
      setIsLoading(true);
      const response = await getPaymentSource({
        client: apiClient,
      });

      if (response.data?.data?.PaymentSources) {
        const paymentSource = response.data.data.PaymentSources[0];
        if (paymentSource) {
          const allWallets: Wallet[] = [
            ...paymentSource.PurchasingWallets.map((wallet) => ({
              ...wallet,
              type: 'Purchasing' as const,
            })),
            ...paymentSource.SellingWallets.map((wallet) => ({
              ...wallet,
              type: 'Selling' as const,
            })),
          ];

          const walletsWithBalances = await Promise.all(
            allWallets.map(async (wallet) => {
              const balances = await fetchWalletBalance(wallet);
              return {
                ...wallet,
                balance: balances.ada,
                usdmBalance: balances.usdm,
              };
            }),
          );

          setAllWallets(walletsWithBalances);
          setFilteredWallets(walletsWithBalances);
        }
      }
    } catch (error) {
      console.error('Error fetching wallets:', error);
      toast.error('Failed to load wallets');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchWallets();
  }, []);

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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Address copied to clipboard');
  };

  const refreshWalletBalance = async (wallet: Wallet) => {
    try {
      setRefreshingBalances((prev) => new Set(prev).add(wallet.id));
      const balances = await fetchWalletBalance(wallet);
      setFilteredWallets((prev) =>
        prev.map((w) =>
          w.id === wallet.id
            ? {
                ...w,
                balance: balances.ada,
                usdmBalance: balances.usdm,
              }
            : w,
        ),
      );
    } catch (error) {
      console.error('Error refreshing wallet balance:', error);
    } finally {
      setRefreshingBalances((prev) => {
        const newSet = new Set(prev);
        newSet.delete(wallet.id);
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

        <div className="rounded-lg border">
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
                  Linked AI agents
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
                filteredWallets.map((wallet) => (
                  <tr key={wallet.id} className="border-b last:border-b-0">
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
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-green-100 text-green-800',
                        )}
                      >
                        {wallet.type}
                      </span>
                    </td>
                    <td className="p-4">{wallet.note || '—'}</td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <span
                          className="font-mono text-sm"
                          title={wallet.walletAddress}
                        >
                          {shortenAddress(wallet.walletAddress)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => copyToClipboard(wallet.walletAddress)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                    <td className="p-4">—</td>
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
                              ? useFormatBalance(wallet.usdmBalance)
                              : '0'}
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
                          onClick={() => refreshWalletBalance(wallet)}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setSelectedWalletForSwap(wallet)}
                        >
                          <FaExchangeAlt className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="text-sm text-muted-foreground mt-4">
          Total: {filteredWallets.length}
        </div>

        {!hasSellingWallets && (
          <div className="rounded-lg border border-orange-200 bg-orange-50 dark:bg-[#f002] dark:border-orange-500/20 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-orange-600 dark:text-orange-400">
                <div className="text-sm">
                  We recommend to add your own wallet to collect funds.{' '}
                  <Link
                    href="https://docs.masumi.network/core-concepts/wallets#three-different-wallets"
                    target="_blank"
                    className="text-orange-600 dark:text-orange-400 hover:underline"
                  >
                    Learn more
                  </Link>
                </div>
              </div>
              <Button
                variant="outline"
                className="border-orange-600 text-orange-600 dark:border-orange-400 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-500/10"
              >
                Add collecting wallet
              </Button>
            </div>
          </div>
        )}
      </div>

      <AddWalletDialog
        open={isAddDialogOpen}
        onClose={() => setIsAddDialogOpen(false)}
        onSuccess={fetchWallets}
      />

      <TransakWidget
        isOpen={!!selectedWalletForTopup}
        onClose={() => setSelectedWalletForTopup(null)}
        walletAddress={selectedWalletForTopup?.walletAddress || ''}
        onSuccess={() => {
          toast.success('Top up successful');
          refreshWalletBalance(selectedWalletForTopup!);
        }}
      />

      <SwapDialog
        isOpen={!!selectedWalletForSwap}
        onClose={() => setSelectedWalletForSwap(null)}
        walletAddress={selectedWalletForSwap?.walletAddress || ''}
        network={state.network}
        blockfrostApiKey={process.env.NEXT_PUBLIC_BLOCKFROST_API_KEY || ''}
        walletType={selectedWalletForSwap?.type || ''}
        walletId={selectedWalletForSwap?.id || ''}
      />
    </MainLayout>
  );
}
