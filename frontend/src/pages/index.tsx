/* eslint-disable react-hooks/rules-of-hooks */

import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import { GetStaticProps } from 'next';
import Head from 'next/head';
import { Button } from '@/components/ui/button';
import { ChevronRight, Plus } from 'lucide-react';
import { cn, shortenAddress } from '@/lib/utils';
import { useEffect, useState, useCallback } from 'react';
import {
  getPaymentSource,
  GetPaymentSourceResponses,
  getRegistry,
  getUtxos,
  GetRegistryResponses,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import Link from 'next/link';
import { AddWalletDialog } from '@/components/wallets/AddWalletDialog';
import { RegisterAIAgentDialog } from '@/components/ai-agents/RegisterAIAgentDialog';
//import { SwapDialog } from '@/components/wallets/SwapDialog';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { useRate } from '@/lib/hooks/useRate';
import { Spinner } from '@/components/ui/spinner';
//import { FaExchangeAlt } from 'react-icons/fa';
import useFormatBalance from '@/lib/hooks/useFormatBalance';
import { useTransactions } from '@/lib/hooks/useTransactions';
import { AIAgentDetailsDialog } from '@/components/ai-agents/AIAgentDetailsDialog';
import { WalletDetailsDialog } from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';
import { TESTUSDM_CONFIG, getUsdmConfig } from '@/lib/constants/defaultWallets';

type AIAgent = GetRegistryResponses['200']['data']['Assets'][0];

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
  const { apiClient, state, selectedPaymentSourceId } = useAppContext();
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [wallets, setWallets] = useState<WalletWithBalance[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [isLoadingWallets, setIsLoadingWallets] = useState(true);
  const [totalBalance, setTotalBalance] = useState('0');
  const [totalUsdmBalance, setTotalUsdmBalance] = useState('0');
  const [isAddWalletDialogOpen, setAddWalletDialogOpen] = useState(false);
  const [isRegisterAgentDialogOpen, setRegisterAgentDialogOpen] =
    useState(false);

  //const [selectedWalletForSwap, setSelectedWalletForSwap] =
  //  useState<WalletWithBalance | null>(null);

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

        const selectedPaymentSource = state.paymentSources?.find(
          (ps) => ps.id === selectedPaymentSourceId,
        );
        const smartContractAddress =
          selectedPaymentSource?.smartContractAddress ?? null;

        const response = await getRegistry({
          client: apiClient,
          query: {
            network: state.network,
            cursorId: cursor || undefined,
            filterSmartContractAddress: smartContractAddress
              ? smartContractAddress
              : undefined,
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
    [apiClient, state.network, state.paymentSources, selectedPaymentSourceId],
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
      setIsLoadingWallets(true);
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
            const main = parseInt(wallet.balance || '0') || 0;
            const collection =
              wallet.collectionBalance && wallet.collectionBalance.ada
                ? parseInt(wallet.collectionBalance.ada)
                : 0;
            return sum + main + collection;
          }, 0);
          const totalUsdmBalance = walletsWithBalances.reduce((sum, wallet) => {
            const main = parseInt(wallet.usdmBalance || '0') || 0;
            const collection =
              wallet.collectionBalance && wallet.collectionBalance.usdm
                ? parseInt(wallet.collectionBalance.usdm)
                : 0;
            return sum + main + collection;
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
  }, [apiClient, fetchWalletBalance, selectedPaymentSourceId]);

  useEffect(() => {
    if (
      state.paymentSources &&
      state.paymentSources.length > 0 &&
      selectedPaymentSourceId
    ) {
      fetchAgents();
    }
  }, [
    fetchAgents,
    state.paymentSources,
    state.network,
    selectedPaymentSourceId,
  ]);

  useEffect(() => {
    if (
      state.paymentSources &&
      state.paymentSources.length > 0 &&
      selectedPaymentSourceId
    ) {
      fetchWallets();
    }
  }, [
    fetchWallets,
    state.paymentSources,
    state.network,
    selectedPaymentSourceId,
  ]);

  const formatUsdValue = (adaAmount: string, usdmAmount: string) => {
    if (!rate || !adaAmount) return '—';
    const ada = parseInt(adaAmount) / 1000000;
    return `≈ $${(ada * rate).toFixed(2)}`;
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
          <p className="text-xs text-muted-foreground mt-5">
            Showing data for{' '}
            {selectedPaymentSourceId
              ? shortenAddress(
                  state.paymentSources.find(
                    (source) => source.id === selectedPaymentSourceId,
                  )?.smartContractAddress ?? 'invalid',
                )
              : 'all payment sources'}
            . This can be changed in the{' '}
            <Link
              href="/payment-sources"
              className="text-primary hover:underline"
            >
              payment sources
            </Link>{' '}
            page.
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
                <div className="text-2xl font-semibold">
                  {
                    agents.filter(
                      (agent) => agent.state === 'RegistrationConfirmed',
                    ).length
                  }
                </div>
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
                        {agent.AgentPricing &&
                          agent.AgentPricing.pricingType == 'Free' && (
                            <span className="text-xs font-normal text-muted-foreground">
                              Free
                            </span>
                          )}
                        {agent.AgentPricing &&
                        agent.AgentPricing.pricingType == 'Fixed' &&
                        agent.AgentPricing.Pricing?.[0] ? (
                          <>
                            <span className="text-xs font-normal text-muted-foreground">
                              {(() => {
                                const price = agent.AgentPricing.Pricing[0];
                                const unit = price.unit;
                                if (unit === 'free') return 'Free';
                                const formatted = (
                                  parseInt(price.amount) / 1_000_000
                                ).toFixed(2);
                                if (unit === 'lovelace' || !unit)
                                  return `${formatted} ADA`;
                                if (
                                  unit ===
                                  getUsdmConfig(state.network).fullAssetId
                                )
                                  return `${formatted} USDM`;
                                if (unit === TESTUSDM_CONFIG.unit)
                                  return `${formatted} tUSDM`;
                                return `${formatted} ${unit}`;
                              })()}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs font-normal text-muted-foreground">
                            —
                          </span>
                        )}
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
                  className="flex items-center gap-2"
                  onClick={() => setRegisterAgentDialogOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  Register agent
                </Button>
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
                {isLoadingWallets ? (
                  <Spinner size={20} addContainer />
                ) : (
                  <div className="mb-4 max-h-[500px] overflow-y-auto overflow-x-auto w-full">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-background z-10">
                        <tr className="text-sm text-muted-foreground border-b">
                          <th className="text-left py-2 px-2 w-20">Type</th>
                          <th className="text-left py-2 px-2">Name</th>
                          <th className="text-left py-2 px-2">Address</th>
                          <th className="text-left py-2 px-2">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wallets.map((wallet) => (
                          <tr
                            key={wallet.id}
                            className="border-b last:border-0 cursor-pointer hover:bg-muted/10"
                            onClick={() => setSelectedWalletForDetails(wallet)}
                          >
                            <td className="py-3 px-2">
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
                            </td>
                            <td className="py-3 px-2 max-w-[100px]">
                              <div className="text-sm font-medium truncate">
                                {wallet.type === 'Purchasing'
                                  ? 'Buying wallet'
                                  : 'Selling wallet'}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">
                                {wallet.note || 'Created by seeding'}
                              </div>
                            </td>
                            <td className="py-3 px-2 max-w-[100px]">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs text-muted-foreground truncate">
                                  {wallet.walletAddress}
                                </span>
                                <CopyButton value={wallet.walletAddress} />
                              </div>
                            </td>
                            <td className="py-3 px-2 w-32">
                              <div className="text-xs flex items-center gap-1">
                                {useFormatBalance(
                                  (parseInt(wallet.balance || '0') / 1000000)
                                    .toFixed(2)
                                    ?.toString(),
                                )}{' '}
                                <span className="text-xs text-muted-foreground">
                                  ADA
                                </span>
                              </div>
                              <div className="text-xs flex items-center gap-1">
                                {useFormatBalance(
                                  (
                                    parseInt(wallet.usdmBalance || '0') /
                                    1000000
                                  )
                                    .toFixed(2)
                                    ?.toString(),
                                )}{' '}
                                <span className="text-xs text-muted-foreground">
                                  USDM
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-2 w-32">
                              <div className="flex items-center gap-2">
                                {/*<Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedWalletForSwap(wallet);
                                  }}
                                >
                                  <FaExchangeAlt className="h-2 w-2" />
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
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-3 text-sm font-normal"
                  onClick={() => setAddWalletDialogOpen(true)}
                >
                  + Add wallet
                </Button>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-muted-foreground">
                    Total: {wallets.length}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </MainLayout>

      <AddWalletDialog
        open={isAddWalletDialogOpen}
        onClose={() => setAddWalletDialogOpen(false)}
        onSuccess={fetchWallets}
      />

      <RegisterAIAgentDialog
        open={isRegisterAgentDialogOpen}
        onClose={() => setRegisterAgentDialogOpen(false)}
        onSuccess={() => {
          setTimeout(() => {
            fetchAgents();
          }, 2000);
        }}
      />

      <AIAgentDetailsDialog
        agent={selectedAgentForDetails}
        onClose={() => setSelectedAgentForDetails(null)}
        onSuccess={() => {
          setTimeout(() => {
            fetchAgents();
          }, 2000);
        }}
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
