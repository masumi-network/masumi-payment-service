/* eslint-disable react-hooks/rules-of-hooks */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import { GetStaticProps } from 'next';
import Head from 'next/head';
import { Button } from '@/components/ui/button';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState, useCallback } from 'react';
import {
  getPaymentSource,
  GetPaymentSourceResponses,
  getRegistry,
  getUtxos,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import Link from 'next/link';
import { AddWalletDialog } from '@/components/wallets/AddWalletDialog';
import { AddAIAgentDialog } from '@/components/ai-agents/AddAIAgentDialog';
import { SwapDialog } from '@/components/wallets/SwapDialog';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { useRate } from '@/lib/hooks/useRate';
import { Spinner } from '@/components/ui/spinner';
import { FaExchangeAlt } from 'react-icons/fa';
import useFormatBalance from '@/lib/hooks/useFormatBalance';
import { useTransactions } from '@/lib/hooks/useTransactions';
import { AIAgentDetailsDialog } from '@/components/ai-agents/AIAgentDetailsDialog';
import { WalletDetailsDialog } from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';

interface AIAgent {
  id: string;
  name: string;
  description: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
  agentIdentifier: string | null;
  Tags: string[];
  SmartContractWallet: {
    walletAddress: string;
    walletVkey: string;
  };
  AgentPricing?: {
    Pricing?: Array<{
      amount: string;
      unit: string;
    }>;
  };
}

type Wallet =
  | (GetPaymentSourceResponses['200']['data']['PaymentSources'][0]['PurchasingWallets'][0] & {
      type: 'Purchasing';
    })
  | (GetPaymentSourceResponses['200']['data']['PaymentSources'][0]['SellingWallets'][0] & {
      type: 'Selling';
    });
type WalletWithBalance = Wallet & {
  balance: string;
  usdmBalance: string;
  collectionBalance?: {
    ada: string;
    usdm: string;
  };
};

export const getStaticProps: GetStaticProps = async () => {
  return {
    props: {},
  };
};

export default function Overview() {
  const { apiClient, state } = useAppContext();
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [wallets, setWallets] = useState<WalletWithBalance[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [isLoadingWallets, setIsLoadingWallets] = useState(true);
  const [totalBalance, setTotalBalance] = useState('0');
  const [totalUsdmBalance, setTotalUsdmBalance] = useState('0');
  const [isAddWalletDialogOpen, setIsAddWalletDialogOpen] = useState(false);
  const [isAddAgentDialogOpen, setIsAddAgentDialogOpen] = useState(false);
  const [selectedWalletForSwap, setSelectedWalletForSwap] =
    useState<WalletWithBalance | null>(null);
  const [selectedWalletForTopup, setSelectedWalletForTopup] =
    useState<WalletWithBalance | null>(null);
  const { rate, isLoading: isLoadingRate } = useRate();
  const { newTransactionsCount, isLoading: isLoadingTransactions } =
    useTransactions();
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedAgentForDetails, setSelectedAgentForDetails] =
    useState<AIAgent | null>(null);
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);

  const fetchAgents = useCallback(
    async (cursor?: string | null) => {
      try {
        if (!cursor) {
          setIsLoadingAgents(true);
          setAgents([]);
        } else {
          setIsLoadingMore(true);
        }

        const response = await getRegistry({
          client: apiClient,
          query: {
            network: state.network,
            cursorId: cursor || undefined,
          },
        });

        if (response.data?.data?.Assets) {
          const newAgents = response.data.data.Assets;
          if (cursor) {
            setAgents((prev) => [...prev, ...newAgents]);
          } else {
            setAgents(newAgents);
          }
          setHasMore(newAgents.length === 10);
        } else {
          if (!cursor) {
            setAgents([]);
          }
          setHasMore(false);
        }
      } catch {
        toast.error('Failed to load AI agents');
      } finally {
        setIsLoadingAgents(false);
        setIsLoadingMore(false);
      }
    },
    [apiClient, state.network],
  );

  const handleLoadMore = () => {
    if (!isLoadingMore && hasMore && agents.length > 0) {
      const lastAgent = agents[agents.length - 1];
      fetchAgents(lastAgent.id);
    }
  };

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

          response.data.data.Utxos.forEach((utxo) => {
            utxo.Amounts.forEach((amount) => {
              if (amount.unit === 'lovelace' || amount.unit == '') {
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
    },
    [apiClient, state.network],
  );

  const fetchWallets = useCallback(async () => {
    try {
      setIsLoadingWallets(true);
      const response = await getPaymentSource({
        client: apiClient,
      });

      if (response.data?.data?.PaymentSources) {
        const paymentSource = response.data.data.PaymentSources.find(
          (source) => source.network === state.network,
        );
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
              const balance = await fetchWalletBalance(wallet.walletAddress);
              let collectionBalance = { ada: '0', usdm: '0' };
              if (wallet.collectionAddress) {
                collectionBalance = await fetchWalletBalance(
                  wallet.collectionAddress,
                );
              }
              return {
                ...wallet,
                usdmBalance: balance.usdm,
                balance: balance.ada,
                collectionBalance,
              };
            }),
          );

          const totalAdaBalance = walletsWithBalances.reduce((sum, wallet) => {
            return sum + (parseInt(wallet.balance || '0') || 0);
          }, 0);
          const totalUsdmBalance = walletsWithBalances.reduce((sum, wallet) => {
            return sum + (parseInt(wallet.usdmBalance || '0') || 0);
          }, 0);

          setTotalBalance(totalAdaBalance.toString());
          setTotalUsdmBalance(totalUsdmBalance.toString());
          setWallets(walletsWithBalances);
        } else {
          setWallets([]);
          setTotalBalance('0');
          setTotalUsdmBalance('0');
        }
      }
    } catch {
      toast.error('Failed to load wallets');
    } finally {
      setIsLoadingWallets(false);
    }
  }, [apiClient, fetchWalletBalance, state.network]);

  useEffect(() => {
    fetchAgents();
    fetchWallets();
  }, [fetchAgents, fetchWallets]);

  const formatUsdValue = (adaAmount: string, usdmAmount: string) => {
    if (!rate || !adaAmount) return '—';
    const ada = parseInt(adaAmount) / 1000000;
    const usdm = parseInt(usdmAmount) / 1000000;
    return `≈ $${(ada * rate + usdm).toFixed(2)}`;
  };

  return (
    <>
      <Head>
        <title>Masumi | Admin Interface</title>
      </Head>
      <MainLayout>
        <div className="mb-8">
          <div className="flex justify-between items-center mb-4">
            <h1 className="text-3xl font-semibold mb-1">Dashboard</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Overview of your AI agents, wallets, and transactions.
          </p>
        </div>

        <div className="mb-8">
          <div className="grid grid-cols-4 gap-4">
            <div className="border rounded-lg p-6">
              <div className="text-sm text-muted-foreground mb-2">
                Total AI agents
              </div>
              {isLoadingAgents ? (
                <Spinner size={20} addContainer />
              ) : (
                <div className="text-2xl font-semibold">{agents.length}</div>
              )}
            </div>
            <div className="border rounded-lg p-6">
              <div className="text-sm text-muted-foreground mb-2">
                Total USDM
              </div>
              {isLoadingWallets ? (
                <Spinner size={20} addContainer />
              ) : (
                <div className="text-2xl font-semibold flex items-center gap-1">
                  <span className="text-xs font-normal text-muted-foreground">
                    $
                  </span>
                  {useFormatBalance(
                    (parseInt(totalUsdmBalance) / 1000000)
                      .toFixed(2)
                      ?.toString(),
                  ) ?? ''}
                </div>
              )}
            </div>
            <div className="border rounded-lg p-6">
              <div className="text-sm text-muted-foreground mb-2">
                Total ada balance
              </div>
              {isLoadingWallets ? (
                <Spinner size={20} addContainer />
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="text-2xl font-semibold flex items-center gap-1">
                    {useFormatBalance(
                      (parseInt(totalBalance) / 1000000).toFixed(2)?.toString(),
                    ) ?? ''}
                    <span className="text-xs font-normal text-muted-foreground">
                      ADA
                    </span>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {isLoadingRate && !totalUsdmBalance
                      ? '...'
                      : `~ $${useFormatBalance(formatUsdValue(totalBalance, totalUsdmBalance))}`}
                  </div>
                </div>
              )}
            </div>
            <div className="border rounded-lg p-6">
              <div className="text-sm text-muted-foreground mb-2">
                New Transactions
              </div>
              {isLoadingTransactions ? (
                <Spinner size={20} addContainer />
              ) : (
                <>
                  <div className="text-2xl font-semibold">
                    {newTransactionsCount}
                  </div>
                  <Link
                    href="/transactions"
                    className="text-sm text-primary hover:underline flex justify-items-center items-center"
                  >
                    View all transactions <ChevronRight size={14} />
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div className="border rounded-lg">
            <div className="p-6">
              <div className="flex justify-between items-center mb-2">
                <div className="flex items-center gap-2">
                  <Link
                    href="/ai-agents"
                    className="font-medium hover:underline"
                  >
                    AI agents
                  </Link>
                  <ChevronRight className="h-4 w-4" />
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Manage your AI agents and their configurations.
              </p>

              {isLoadingAgents ? (
                <Spinner size={20} addContainer />
              ) : agents.length > 0 ? (
                <div className="mb-4 max-h-[500px] overflow-y-auto">
                  {agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="flex items-center justify-between py-4 border-b last:border-0 cursor-pointer hover:bg-muted/10"
                      onClick={() => setSelectedAgentForDetails(agent)}
                    >
                      <div className="flex flex-col gap-1 max-w-[80%]">
                        <div className="text-sm font-medium hover:underline">
                          {agent.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {agent.description}
                        </div>
                      </div>
                      <div className="text-sm min-w-content flex items-center gap-1">
                        <span className="text-xs font-normal text-muted-foreground">
                          {agent.AgentPricing?.Pricing?.[0]?.amount
                            ? `${parseInt(agent.AgentPricing.Pricing[0].amount) / 1000000}`
                            : '—'}
                        </span>
                        <span>₳</span>
                      </div>
                    </div>
                  ))}
                  {hasMore && (
                    <div className="flex justify-center pt-4">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleLoadMore}
                        disabled={isLoadingMore}
                      >
                        {isLoadingMore ? <Spinner size={16} /> : 'Load more'}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground mb-4 py-4">
                  No AI agents found.
                </div>
              )}

              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-3 text-sm font-normal"
                  onClick={() => setIsAddAgentDialogOpen(true)}
                >
                  + Add AI agent
                </Button>
                {/* <div className="flex items-center gap-4 text-sm">
                  <span className="text-muted-foreground">
                    Total: {agents.length}
                  </span>
                </div> */}
              </div>
            </div>
          </div>

          <div className="border rounded-lg">
            <div className="p-6">
              <div className="flex justify-between items-center mb-2">
                <div className="flex items-center gap-2">
                  <Link href="/wallets" className="font-medium hover:underline">
                    Wallets
                  </Link>
                  <ChevronRight className="h-4 w-4" />
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Manage your buying and selling wallets.
              </p>

              <div className="mb-4">
                <div className="grid grid-cols-[80px_1fr_1.5fr_230px] gap-4 text-sm text-muted-foreground mb-2">
                  <div>Type</div>
                  <div>Name</div>
                  <div>Address</div>
                  <div className="text-left">Balance</div>
                </div>

                {isLoadingWallets ? (
                  <Spinner size={20} addContainer />
                ) : (
                  <div className="mb-4 max-h-[500px] overflow-y-auto">
                    {wallets.slice(0, 4).map((wallet) => (
                      <div
                        key={wallet.id}
                        className="grid grid-cols-[80px_1fr_1.5fr_230px] gap-4 items-center py-3 border-b last:border-0 cursor-pointer hover:bg-muted/10"
                        onClick={() => setSelectedWalletForDetails(wallet)}
                      >
                        <div>
                          <span
                            className={cn(
                              'text-xs font-medium px-2 py-0.5 rounded-full',
                              wallet.type === 'Purchasing'
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-orange-50 dark:bg-[#f002] text-orange-600 dark:text-orange-400',
                            )}
                          >
                            {wallet.type === 'Purchasing'
                              ? 'Buying'
                              : 'Selling'}
                          </span>
                        </div>
                        <div>
                          <div className="text-sm font-medium truncate">
                            {wallet.type === 'Purchasing'
                              ? 'Buying wallet'
                              : 'Selling wallet'}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {wallet.note || 'Created by seeding'}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-muted-foreground">
                            {wallet.walletAddress.slice(0, 12)}...
                          </span>
                          <CopyButton value={wallet.walletAddress} />
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex flex-col items-start">
                            <span className="text-sm flex items-center gap-1">
                              {useFormatBalance(
                                (parseInt(wallet.balance || '0') / 1000000)
                                  .toFixed(2)
                                  ?.toString(),
                              )}
                              <span className="text-xs text-muted-foreground">
                                ADA
                              </span>
                            </span>
                            <span className="text-sm flex items-center gap-1">
                              {useFormatBalance(
                                (parseInt(wallet.usdmBalance || '0') / 1000000)
                                  .toFixed(2)
                                  ?.toString(),
                              )}
                              <span className="text-xs text-muted-foreground">
                                USDM
                              </span>
                            </span>
                          </div>
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
                              <FaExchangeAlt className="h-2 w-2" />
                            </Button>
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
                        </div>
                      </div>
                    ))}

                    {/* Collection Wallet Section */}
                    {wallets.map((wallet) => {
                      if (!wallet.collectionAddress) return null;
                      return (
                        <div
                          key={`collection-${wallet.id}`}
                          className="grid grid-cols-[80px_1fr_1.5fr_230px] gap-4 items-center py-3 border-b last:border-0 cursor-pointer hover:bg-muted/10"
                          onClick={() =>
                            setSelectedWalletForDetails({
                              ...wallet,
                              walletAddress: wallet.collectionAddress!,
                              type: 'Collection' as any,
                              balance: wallet.collectionBalance?.ada || '0',
                              usdmBalance:
                                wallet.collectionBalance?.usdm || '0',
                            })
                          }
                        >
                          <div>
                            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-600 dark:text-blue-400">
                              Collection
                            </span>
                          </div>
                          <div>
                            <div className="text-xs font-medium truncate">
                              Collection wallet
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {wallet.note && `${wallet.note}`}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">
                              {wallet.collectionAddress.slice(0, 12)}...
                            </span>
                            <CopyButton value={wallet.collectionAddress!} />
                          </div>
                          <div className="flex flex-col items-start">
                            <span className="text-sm flex items-center gap-1">
                              {useFormatBalance(
                                (
                                  parseInt(
                                    wallet.collectionBalance?.ada || '0',
                                  ) / 1000000
                                )
                                  .toFixed(2)
                                  ?.toString(),
                              )}
                              <span className="text-xs text-muted-foreground">
                                ADA
                              </span>
                            </span>
                            <span className="text-sm flex items-center gap-1">
                              {useFormatBalance(
                                (
                                  parseInt(
                                    wallet.collectionBalance?.usdm || '0',
                                  ) / 1000000
                                )
                                  .toFixed(2)
                                  ?.toString(),
                              )}
                              <span className="text-xs text-muted-foreground">
                                USDM
                              </span>
                            </span>
                          </div>
                        </div>
                      );
                    })}

                    {/* Show add collection wallet message if no collection addresses exist */}
                    {!wallets.some((w) => w.collectionAddress) && (
                      <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-[#0002] dark:border-blue-500/20 p-4 my-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                            <div className="text-sm">
                              Add a collection wallet to manage your funds more
                              effectively.
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            className="border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/10"
                            onClick={() => setIsAddWalletDialogOpen(true)}
                          >
                            Add collection wallet
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-3 text-sm font-normal"
                  onClick={() => setIsAddWalletDialogOpen(true)}
                >
                  + Add wallet
                </Button>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-muted-foreground">
                    Total:{' '}
                    {wallets.length +
                      wallets.filter((w) => w.collectionAddress).length}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </MainLayout>

      <AddWalletDialog
        open={isAddWalletDialogOpen}
        onClose={() => setIsAddWalletDialogOpen(false)}
        onSuccess={fetchWallets}
      />

      <AddAIAgentDialog
        open={isAddAgentDialogOpen}
        onClose={() => setIsAddAgentDialogOpen(false)}
        onSuccess={fetchAgents}
      />

      <AIAgentDetailsDialog
        agent={selectedAgentForDetails}
        onClose={() => setSelectedAgentForDetails(null)}
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

      <TransakWidget
        isOpen={!!selectedWalletForTopup}
        onClose={() => setSelectedWalletForTopup(null)}
        walletAddress={selectedWalletForTopup?.walletAddress || ''}
        onSuccess={() => {
          toast.success('Top up successful');
          fetchWallets();
        }}
      />

      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
      />
    </>
  );
}
