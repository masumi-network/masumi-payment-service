/* eslint-disable react-hooks/rules-of-hooks */

import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import { GetStaticProps } from 'next';
import Head from 'next/head';
import { Button } from '@/components/ui/button';
import { Copy, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState, useCallback } from 'react';
import {
  getPaymentSource,
  GetPaymentSourceResponses,
  getRegistry,
  getUtxos,
  GetUtxosResponses,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import Link from 'next/link';
import { AddWalletDialog } from '@/components/wallets/AddWalletDialog';
import { AddAIAgentDialog } from '@/components/ai-agents/AddAIAgentDialog';
import { SwapDialog } from '@/components/wallets/SwapDialog';
import { useRate } from '@/lib/hooks/useRate';
import { Spinner } from '@/components/ui/spinner';
import { FaExchangeAlt } from 'react-icons/fa';
import useFormatBalance from '@/lib/hooks/useFormatBalance';
import { useTransactions } from '@/lib/hooks/useTransactions';

interface AIAgent {
  id: string;
  name: string;
  description: string | null;
  state: string;
  SmartContractWallet: {
    walletAddress: string;
  };
  AgentPricing: {
    Pricing: Array<{
      amount: string;
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
type WalletWithBalance = Wallet & { balance: string; usdmBalance: string };

type UTXO = GetUtxosResponses['200']['data']['Utxos'][0];

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
  const { rate, isLoading: isLoadingRate } = useRate();
  const { newTransactionsCount, isLoading: isLoadingTransactions } =
    useTransactions();

  const fetchAgents = useCallback(async () => {
    try {
      setIsLoadingAgents(true);
      const response = await getRegistry({
        client: apiClient,
        query: {
          network: 'Preprod',
        },
      });

      if (response.data?.data?.Assets) {
        setAgents(response.data.data.Assets);
      }
    } catch {
      toast.error('Failed to load AI agents');
    } finally {
      setIsLoadingAgents(false);
    }
  }, [apiClient]);

  const fetchWalletBalance = useCallback(
    async (wallet: Wallet) => {
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
              const balance = await fetchWalletBalance(wallet);
              return {
                ...wallet,
                usdmBalance: balance.usdm,
                balance: balance.ada,
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
        }
      }
    } catch {
      toast.error('Failed to load wallets');
    } finally {
      setIsLoadingWallets(false);
    }
  }, [apiClient, fetchWalletBalance]);

  useEffect(() => {
    fetchAgents();
    fetchWallets();
  }, [fetchAgents, fetchWallets]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Address copied to clipboard');
  };

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
                Total wallets
              </div>
              {isLoadingWallets ? (
                <Spinner size={20} addContainer />
              ) : (
                <div className="text-2xl font-semibold">{wallets.length}</div>
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
            <div className="border rounded-lg p-6">
              <div className="text-sm text-muted-foreground mb-2">
                Total balance
              </div>
              {isLoadingWallets ? (
                <Spinner size={20} addContainer />
              ) : (
                <>
                  <div className="text-2xl font-semibold">
                    ₳{' '}
                    {useFormatBalance(
                      (parseInt(totalBalance) / 1000000).toFixed(2)?.toString(),
                    ) ?? ''}{' '}
                    {' + '}
                  </div>
                  <div className="text-2xl font-semibold">
                    ${' '}
                    {useFormatBalance(
                      (parseInt(totalUsdmBalance) / 1000000)
                        .toFixed(2)
                        ?.toString(),
                    ) ?? ''}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {isLoadingRate && !totalUsdmBalance
                      ? '...'
                      : `~ $${useFormatBalance(formatUsdValue(totalBalance, totalUsdmBalance))}`}
                  </div>
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
                <div className="space-y-4 mb-4">
                  {agents.slice(0, 2).map((agent) => (
                    <div
                      key={agent.id}
                      className="flex items-center justify-between py-2 border-b last:border-0"
                    >
                      <div>
                        <div className="text-sm font-medium">{agent.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {agent.description}
                        </div>
                      </div>
                      <div className="text-sm">
                        {agent.AgentPricing.Pricing[0]?.amount
                          ? `${parseInt(agent.AgentPricing.Pricing[0].amount) / 1000000} ₳`
                          : '—'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground mb-4">
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
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-muted-foreground">
                    Total: {agents.length}
                  </span>
                </div>
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
                <div className="grid grid-cols-[80px_1fr_1.5fr_120px] gap-4 text-sm text-muted-foreground mb-2">
                  <div>Type</div>
                  <div>Name</div>
                  <div>Address</div>
                  <div className="text-right">Balance, ADA</div>
                </div>

                {isLoadingWallets ? (
                  <Spinner size={20} addContainer />
                ) : (
                  <div className="space-y-2">
                    {wallets.slice(0, 2).map((wallet) => (
                      <div
                        key={wallet.id}
                        className="grid grid-cols-[80px_1fr_1.5fr_120px] gap-4 items-center py-3 border-b last:border-0"
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
                          <div className="text-sm font-medium">
                            {wallet.type === 'Purchasing'
                              ? 'Buying wallet'
                              : 'Selling wallet'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {wallet.note || 'Created by seeding'}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 p-0"
                            onClick={() =>
                              copyToClipboard(wallet.walletAddress)
                            }
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <span className="font-mono text-sm text-muted-foreground">
                            {wallet.walletAddress.slice(0, 12)}...
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm">
                            {wallet.balance
                              ? `₳${useFormatBalance((parseInt(wallet.balance) / 1000000).toFixed(2)?.toString())}`
                              : '—'}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setSelectedWalletForSwap(wallet)}
                          >
                            <FaExchangeAlt className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
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
        onClose={() => setIsAddWalletDialogOpen(false)}
        onSuccess={fetchWallets}
      />

      <AddAIAgentDialog
        open={isAddAgentDialogOpen}
        onClose={() => setIsAddAgentDialogOpen(false)}
        onSuccess={fetchAgents}
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
    </>
  );
}
