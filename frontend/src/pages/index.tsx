import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import { GetStaticProps } from 'next';
import Head from 'next/head';
import { Button } from '@/components/ui/button';
import {
  ChevronRight,
  Plus,
  Bot,
  DollarSign,
  Wallet,
  ArrowUpDown,
  ArrowLeftRight,
  PlusCircle,
} from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { cn, shortenAddress } from '@/lib/utils';
import { useState, useMemo } from 'react';
import { RegistryEntry } from '@/lib/api/generated';
import { useAgents } from '@/lib/queries/useAgents';
import { useWallets, WalletWithBalance } from '@/lib/queries/useWallets';
import { useQueryClient } from '@tanstack/react-query';
import { useTransactions } from '@/lib/hooks/useTransactions';
import { toast } from 'react-toastify';
import Link from 'next/link';
import { AddWalletDialog } from '@/components/wallets/AddWalletDialog';
import { RegisterAIAgentDialog } from '@/components/ai-agents/RegisterAIAgentDialog';
import { SwapDialog } from '@/components/wallets/SwapDialog';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { useRate } from '@/lib/hooks/useRate';
import { StatCardSkeleton } from '@/components/skeletons/StatCardSkeleton';
import { AgentListSkeleton } from '@/components/skeletons/AgentListSkeleton';
import { WalletListSkeleton } from '@/components/skeletons/WalletListSkeleton';
import { Spinner } from '@/components/ui/spinner';
import formatBalance from '@/lib/formatBalance';
import { WalletTypeBadge } from '@/components/ui/wallet-type-badge';
import { AIAgentDetailsDialog } from '@/components/ai-agents/AIAgentDetailsDialog';
import { WalletDetailsDialog } from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';
import { TESTUSDM_CONFIG, getUsdmConfig, getUsdcxConfig } from '@/lib/constants/defaultWallets';
import { AnimatedPage } from '@/components/ui/animated-page';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { WelcomeBanner } from '@/components/ui/welcome-banner';

type AIAgent = RegistryEntry;

export const getStaticProps: GetStaticProps = async () => {
  return {
    props: {},
  };
};

export default function Overview() {
  const { network, selectedPaymentSource } = useAppContext();

  const queryClient = useQueryClient();
  const {
    transactions,
    newTransactionsCount,
    isLoading: isLoadingTransactions,
  } = useTransactions();

  // Use React Query hooks for cached data
  const {
    agents,
    isLoading: isLoadingAgents,
    hasMore: hasMoreAgents,
    loadMore: loadMoreAgents,
  } = useAgents();
  const {
    wallets: walletsList,
    totalBalance: totalBalanceValue,
    totalUsdcxBalance: totalUsdcxBalanceValue,
    isLoading: isLoadingWallets,
  } = useWallets();

  const totalBalance = useMemo(() => totalBalanceValue || '0', [totalBalanceValue]);
  const totalUsdcxBalance = useMemo(() => totalUsdcxBalanceValue || '0', [totalUsdcxBalanceValue]);
  const isLoadingBalances = isLoadingWallets;

  // Refetch functions for after mutations
  const refetchAgents = () => {
    queryClient.invalidateQueries({ queryKey: ['agents'] });
  };

  const refetchWallets = () => {
    queryClient.invalidateQueries({ queryKey: ['wallets'] });
  };
  const [isAddWalletDialogOpen, setAddWalletDialogOpen] = useState(false);
  const [isRegisterAgentDialogOpen, setRegisterAgentDialogOpen] = useState(false);

  const [selectedWalletForSwap, setSelectedWalletForSwap] = useState<WalletWithBalance | null>(
    null,
  );

  const [selectedWalletForTopup, setSelectedWalletForTopup] = useState<WalletWithBalance | null>(
    null,
  );
  const { rate, isLoading: isLoadingRate } = useRate();

  const [selectedAgentForDetails, setSelectedAgentForDetails] = useState<AIAgent | null>(null);
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);

  const formatUsdValue = (adaAmount: string) => {
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
        <AnimatedPage>
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
              <p className="text-sm text-muted-foreground">
                Overview of your AI agents, wallets, and transactions.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Showing data for{' '}
                {selectedPaymentSource?.smartContractAddress
                  ? shortenAddress(selectedPaymentSource?.smartContractAddress)
                  : 'all payment sources'}
                . This can be changed in the{' '}
                <Link href="/payment-sources" className="text-primary hover:underline">
                  payment sources
                </Link>{' '}
                page.
              </p>
            </div>

            <WelcomeBanner
              agentCount={agents.length}
              walletCount={walletsList.length}
              transactionCount={transactions.length}
              hasPaymentSource={!!selectedPaymentSource}
            />

            <div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {isLoadingAgents ? (
                  <StatCardSkeleton />
                ) : (
                  <StatCard
                    label="Total AI agents"
                    index={0}
                    icon={<Bot className="h-4 w-4 text-blue-500" />}
                    accentColor="rgb(59, 130, 246)"
                  >
                    <div className="text-2xl font-semibold">
                      {agents.length}
                      {hasMoreAgents ? '+' : ''}
                    </div>
                  </StatCard>
                )}
                {isLoadingWallets || isLoadingBalances ? (
                  <StatCardSkeleton />
                ) : (
                  <StatCard
                    label={network === 'Mainnet' ? 'Total USDCx' : 'Total tUSDM'}
                    index={1}
                    icon={<DollarSign className="h-4 w-4 text-green-500" />}
                    accentColor="rgb(34, 197, 94)"
                  >
                    <div className="text-2xl font-semibold flex items-center gap-1">
                      <span className="text-xs font-normal text-muted-foreground">$</span>
                      {formatBalance((parseInt(totalUsdcxBalance) / 1000000).toFixed(2)) ?? ''}
                    </div>
                  </StatCard>
                )}
                {isLoadingWallets || isLoadingBalances ? (
                  <StatCardSkeleton />
                ) : (
                  <StatCard
                    label="Total ada balance"
                    index={2}
                    icon={<Wallet className="h-4 w-4 text-orange-500" />}
                    accentColor="rgb(249, 115, 22)"
                  >
                    <div className="flex flex-col gap-2">
                      <div className="text-2xl font-semibold flex items-center gap-1">
                        {formatBalance((parseInt(totalBalance) / 1000000).toFixed(2)?.toString()) ??
                          ''}
                        <span className="text-xs font-normal text-muted-foreground">ADA</span>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {isLoadingRate && !totalUsdcxBalance
                          ? '...'
                          : `~ $${formatBalance(formatUsdValue(totalBalance))}`}
                      </div>
                    </div>
                  </StatCard>
                )}
                {isLoadingTransactions ? (
                  <StatCardSkeleton />
                ) : (
                  <StatCard
                    label="New Transactions"
                    index={3}
                    icon={<ArrowUpDown className="h-4 w-4 text-purple-500" />}
                    accentColor="rgb(168, 85, 247)"
                  >
                    <>
                      <div className="text-2xl font-semibold">{newTransactionsCount}</div>
                      <Link
                        href="/transactions"
                        className="text-sm text-primary hover:underline flex justify-items-center items-center"
                      >
                        View all transactions <ChevronRight size={14} />
                      </Link>
                    </>
                  </StatCard>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="border rounded-lg p-6 flex flex-col">
                <div className="flex-1">
                  <div className="flex justify-between items-center mb-2">
                    <div className="flex items-center gap-2">
                      <Link href="/ai-agents" className="font-medium hover:underline">
                        AI agents
                      </Link>
                      <ChevronRight className="h-4 w-4" />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">
                    Manage your AI agents and their configurations.
                  </p>

                  {isLoadingAgents ? (
                    <AgentListSkeleton items={3} />
                  ) : agents.length > 0 ? (
                    <div className="animate-content-reveal mb-4 max-h-125 overflow-y-auto">
                      {agents.map((agent, index) => (
                        <div
                          key={agent.id}
                          className="flex items-center justify-between py-4 border-b last:border-0 cursor-pointer transition-all duration-150 hover:bg-muted/30 hover:pl-1 animate-fade-in-up opacity-0"
                          style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                          onClick={() => setSelectedAgentForDetails(agent)}
                        >
                          <div className="flex flex-col gap-1 max-w-[80%]">
                            <div className="text-sm font-medium hover:underline">{agent.name}</div>
                            <div className="text-xs text-muted-foreground truncate">
                              {agent.description}
                            </div>
                          </div>
                          <div className="text-sm min-w-content flex items-center gap-1">
                            {agent.AgentPricing && agent.AgentPricing.pricingType == 'Free' && (
                              <span className="text-xs font-normal text-muted-foreground">
                                Free
                              </span>
                            )}
                            {agent.AgentPricing && agent.AgentPricing.pricingType == 'Dynamic' && (
                              <span className="text-xs font-normal text-muted-foreground">
                                Dynamic
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
                                    const formatted = (parseInt(price.amount) / 1_000_000).toFixed(
                                      2,
                                    );
                                    if (unit === 'lovelace' || !unit) return `${formatted} ADA`;
                                    if (unit === getUsdcxConfig(network).fullAssetId)
                                      return `${formatted} USDCx`;
                                    if (unit === getUsdmConfig(network).fullAssetId)
                                      return `${formatted} USDM`;
                                    if (unit === TESTUSDM_CONFIG.unit) return `${formatted} tUSDM`;
                                    return `${formatted} ${unit}`;
                                  })()}
                                </span>
                              </>
                            ) : (
                              <span className="text-xs font-normal text-muted-foreground">—</span>
                            )}
                          </div>
                        </div>
                      ))}
                      {hasMoreAgents && (
                        <div className="flex justify-center pt-4">
                          <Button
                            variant="outline"
                            size="sm"
                            className="btn-hover-lift"
                            onClick={() => loadMoreAgents()}
                            disabled={!hasMoreAgents || isLoadingAgents}
                          >
                            Load more
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <EmptyState
                      title="No AI agents found"
                      description="Register your first AI agent to get started."
                    />
                  )}
                </div>

                <div className="pt-4">
                  <Button
                    className="flex items-center gap-2 btn-hover-lift"
                    onClick={() => setRegisterAgentDialogOpen(true)}
                  >
                    <Plus className="h-4 w-4" />
                    Register agent
                  </Button>
                </div>
              </div>

              <div className="border rounded-lg p-6 flex flex-col">
                <div className="flex-1">
                  <div className="flex justify-between items-center mb-2">
                    <div className="flex items-center gap-2">
                      <Link href="/wallets" className="font-medium hover:underline">
                        Wallets
                      </Link>
                      <ChevronRight className="h-4 w-4" />
                      <RefreshButton
                        onRefresh={() => refetchWallets()}
                        isRefreshing={isLoadingWallets || isLoadingBalances}
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">
                    Manage your buying and selling wallets.
                  </p>

                  {isLoadingWallets ? (
                    <WalletListSkeleton rows={2} />
                  ) : (
                    <div className="animate-content-reveal mb-4 max-h-125 overflow-y-auto overflow-x-auto w-full">
                      <table className="w-full">
                        <thead className="sticky top-0 bg-muted/30 dark:bg-muted/15 z-10">
                          <tr className="text-sm text-muted-foreground border-b">
                            <th className="text-left py-2 px-2 w-20">Type</th>
                            <th className="text-left py-2 px-2">Name</th>
                            <th className="text-left py-2 px-2">Address</th>
                            <th className="text-left py-2 px-2">Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {walletsList.length === 0 ? (
                            <tr>
                              <td colSpan={4}>
                                <EmptyState title="No wallets found" />
                              </td>
                            </tr>
                          ) : (
                            walletsList.map((wallet, index) => (
                              <tr
                                key={wallet.id}
                                className={cn(
                                  'border-b last:border-0 cursor-pointer animate-fade-in opacity-0 transition-[background-color,opacity] duration-150',
                                  wallet.LowBalanceSummary?.isLow
                                    ? 'bg-amber-500/5 hover:bg-amber-500/10'
                                    : 'hover:bg-muted/10',
                                )}
                                style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                                onClick={() => setSelectedWalletForDetails(wallet)}
                              >
                                <td className="py-3 px-2">
                                  <div className="flex items-center gap-2">
                                    <WalletTypeBadge type={wallet.type} />
                                    {wallet.LowBalanceSummary?.isLow && (
                                      <>
                                        <span
                                          aria-hidden="true"
                                          className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.16)]"
                                          title={
                                            wallet.LowBalanceSummary.lowRuleCount === 1
                                              ? '1 low-balance alert'
                                              : `${wallet.LowBalanceSummary.lowRuleCount} low-balance alerts`
                                          }
                                        />
                                        <span className="sr-only">
                                          {wallet.LowBalanceSummary.lowRuleCount === 1
                                            ? '1 low-balance alert'
                                            : `${wallet.LowBalanceSummary.lowRuleCount} low-balance alerts`}
                                        </span>
                                      </>
                                    )}
                                  </div>
                                </td>
                                <td className="py-3 px-2 max-w-25">
                                  <div className="text-sm font-medium truncate">
                                    {wallet.type === 'Purchasing'
                                      ? 'Buying wallet'
                                      : 'Selling wallet'}
                                  </div>
                                  <div className="text-xs text-muted-foreground truncate">
                                    {wallet.note || 'Created by seeding'}
                                  </div>
                                </td>
                                <td className="py-3 px-2 max-w-25">
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-xs text-muted-foreground truncate">
                                      {wallet.walletAddress}
                                    </span>
                                    <CopyButton value={wallet.walletAddress} />
                                  </div>
                                </td>
                                <td className="py-3 px-2 w-32">
                                  <div className="text-xs flex items-center gap-1">
                                    {wallet.isLoadingBalance ? (
                                      <Spinner className="h-3 w-3" />
                                    ) : (
                                      <>
                                        {formatBalance(
                                          (parseInt(wallet.balance || '0') / 1000000)
                                            .toFixed(2)
                                            ?.toString(),
                                        )}{' '}
                                        <span className="text-xs text-muted-foreground">ADA</span>
                                      </>
                                    )}
                                  </div>
                                  <div className="text-xs flex items-center gap-1">
                                    {!wallet.isLoadingBalance && (
                                      <>
                                        {formatBalance(
                                          (parseInt(wallet.usdcxBalance || '0') / 1000000)
                                            .toFixed(2)
                                            ?.toString(),
                                        )}{' '}
                                        <span className="text-xs text-muted-foreground">
                                          {network === 'Mainnet' ? 'USDCx' : 'tUSDM'}
                                        </span>
                                      </>
                                    )}
                                  </div>
                                </td>
                                <td className="py-3 px-2 w-32">
                                  <div className="flex items-center gap-2">
                                    {wallet.network === 'Mainnet' && (
                                      <Button
                                        variant="ghost"
                                        size="icon"
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
                                      variant="muted"
                                      className="h-8 btn-hover-lift"
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
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="pt-4">
                  <Button
                    className="flex items-center gap-2 btn-hover-lift"
                    onClick={() => setAddWalletDialogOpen(true)}
                  >
                    <Plus className="h-4 w-4" />
                    Add wallet
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </AnimatedPage>
      </MainLayout>

      <AddWalletDialog
        open={isAddWalletDialogOpen}
        onClose={() => setAddWalletDialogOpen(false)}
        onSuccess={refetchWallets}
      />

      <RegisterAIAgentDialog
        open={isRegisterAgentDialogOpen}
        onClose={() => setRegisterAgentDialogOpen(false)}
        onSuccess={() => {
          setTimeout(() => {
            refetchAgents();
          }, 2000);
        }}
      />

      <AIAgentDetailsDialog
        agent={selectedAgentForDetails}
        onClose={() => setSelectedAgentForDetails(null)}
        onSuccess={() => {
          setTimeout(() => {
            refetchAgents();
          }, 2000);
        }}
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
        onSuccess={() => {
          toast.success('Top up successful');
          refetchWallets();
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
