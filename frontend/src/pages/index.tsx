import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import { GetStaticProps } from 'next';
import Head from 'next/head';
import { Button } from '@/components/ui/button';
import {
  Plus,
  ArrowUpRight,
  Bot,
  DollarSign,
  Wallet,
  ArrowUpDown,
  ChevronRight,
} from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { cn, formatAssetAmount, formatSixDecimalAmount, shortenAddress } from '@/lib/utils';
import { useState, useMemo, useEffect } from 'react';
import { RegistryEntry } from '@/lib/api/generated';
import { useAgents, useRegistryAgentCount } from '@/lib/queries/useAgents';
import { useWallets, WalletWithBalance } from '@/lib/queries/useWallets';
import { useQueryClient } from '@tanstack/react-query';
import { resetAgentQueries } from '@/lib/queries/agent-cache';
import { useTransactions } from '@/lib/hooks/useTransactions';
import Link from 'next/link';
import { AddWalletDialog } from '@/components/wallets/AddWalletDialog';
import { RegisterAIAgentDialog } from '@/components/ai-agents/RegisterAIAgentDialog';
import { useRate } from '@/lib/hooks/useRate';
import { StatCardSkeleton } from '@/components/skeletons/StatCardSkeleton';
import { AgentListSkeleton } from '@/components/skeletons/AgentListSkeleton';
import { WalletListSkeleton } from '@/components/skeletons/WalletListSkeleton';
import formatBalance from '@/lib/formatBalance';
import {
  DashboardPanel,
  OverviewList,
  OverviewListScroll,
  OverviewListItem,
  overviewAgentPriceColumnClass,
  overviewWalletListRowClass,
  overviewListSecondaryLineClass,
} from '@/components/dashboard/dashboard-overview-section';
import { DashboardWalletListSection } from '@/components/dashboard/dashboard-wallet-list-section';
import { AIAgentDetailsDialog } from '@/components/ai-agents/AIAgentDetailsDialog';
import { WalletDetailsDialog } from '@/components/wallets/WalletDetailsDialog';
import { AnimatedPage } from '@/components/ui/animated-page';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { WelcomeBanner } from '@/components/ui/welcome-banner';
import { isWalletFundStepComplete } from '@/components/ui/welcome-banner-fund-step';
import { SetupV2Banner } from '@/components/setup/SetupV2Banner';
import { MigrateAgentsDialog } from '@/components/ai-agents/MigrateAgentsDialog';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { getPrimaryCardanoPricing } from '@/lib/registry-pricing';
import { FinancialReportSection } from '@/components/dashboard/FinancialReportSection';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';

// The dashboard carries two unrelated jobs: what exists (agents, wallets,
// transactions) and what it earned. Stacking both in one scroll buried the
// second, so each gets its own tab.
const OVERVIEW_TAB = 'Overview';
const FINANCES_TAB = 'Finances';
const DASHBOARD_TABS = [{ name: OVERVIEW_TAB }, { name: FINANCES_TAB }];

type AIAgent = RegistryEntry;

function formatAgentListPrice(agent: RegistryEntry, network: 'Preprod' | 'Mainnet') {
  const pricing = getPrimaryCardanoPricing(agent);
  if (pricing?.pricingType === 'Free') return 'Free';
  if (pricing?.pricingType === 'Dynamic') return 'Dynamic';
  if (pricing?.pricingType === 'Fixed' && pricing.Pricing[0]) {
    const price = pricing.Pricing[0];
    return formatAssetAmount(price.amount, price.unit, network);
  }
  return '—';
}

export const getStaticProps: GetStaticProps = async () => {
  return {
    props: {},
  };
};

export default function Overview() {
  const { network, selectedPaymentSource, selectedPaymentSourceId, capabilities } = useAppContext();
  const { paymentSources, isLoading: isLoadingPaymentSources } = usePaymentSourceExtendedAll();
  const [activeDashboardTab, setActiveDashboardTab] = useState(OVERVIEW_TAB);
  const [isMigrationHintDismissed, setIsMigrationHintDismissed] = useState(false);

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
    isFetching: isFetchingAgents,
  } = useAgents();
  const { total: totalAgentCount, isLoading: isLoadingAgentCount } = useRegistryAgentCount();
  // Defer the eager all-wallet balance load until after the dashboard shell has
  // painted, so its N+1 per-wallet UTxO fan-out doesn't compete with first
  // render. A single frame is enough to let the layout + skeletons show first.
  //
  // The timer is not redundant: requestAnimationFrame never fires while the tab
  // is hidden, so opening the dashboard in a background tab (or restoring one)
  // would otherwise leave this false forever and pin the wallet section and the
  // balance cards on their skeletons until the tab was focused.
  const [walletsReady, setWalletsReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setWalletsReady(true));
    const timer = setTimeout(() => setWalletsReady(true), 200);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, []);
  const {
    wallets: walletsList,
    totalBalance: totalBalanceValue,
    totalUsdcxBalance: totalUsdcxBalanceValue,
    isLoading: isLoadingWalletsQuery,
  } = useWallets({ enabled: walletsReady });
  // Keep the balance cards in their loading state during the pre-paint defer
  // window so they never flash an empty "0" before the fetch starts.
  const isLoadingWallets = !walletsReady || isLoadingWalletsQuery;

  const totalBalance = useMemo(() => totalBalanceValue || '0', [totalBalanceValue]);
  const totalUsdcxBalance = useMemo(() => totalUsdcxBalanceValue || '0', [totalUsdcxBalanceValue]);
  const isLoadingBalances = isLoadingWallets;
  const hasFundedWallet = useMemo(
    () =>
      isWalletFundStepComplete({
        isLoading: isLoadingWallets,
        wallets: walletsList,
      }),
    [isLoadingWallets, walletsList],
  );
  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((source) => source.network === network),
    [paymentSources, network],
  );
  // The agents/wallets queries are gated on a selected payment source, so while
  // the source list is still resolving (or a source is being auto-selected) those
  // queries are DISABLED and report `isLoading === false`. Treat that window as
  // loading too, so sections render a skeleton instead of flashing an empty state
  // before the query can even start.
  const isContextResolving =
    isLoadingPaymentSources || (currentNetworkPaymentSources.length > 0 && !selectedPaymentSource);
  const agentsSectionLoading = isContextResolving || isLoadingAgents;
  const walletsSectionLoading = isContextResolving || isLoadingWallets;
  const selectedSourceIsV1 = selectedPaymentSource
    ? !isV2PaymentSource(selectedPaymentSource)
    : false;
  const canMigrateFromSelectedSource =
    selectedSourceIsV1 && currentNetworkPaymentSources.some(isV2PaymentSource);
  const showMigrationHint = canMigrateFromSelectedSource && !isMigrationHintDismissed;

  // Refetch functions for after mutations
  // Only called after a mutation (register / delete / deregister) from the
  // dashboard, so clear the agent lists to their skeleton while fresh data loads.
  const refetchAgents = () => {
    resetAgentQueries(queryClient);
  };

  const refetchWallets = () => {
    queryClient.invalidateQueries({ queryKey: ['wallets'] });
  };
  const [isAddWalletDialogOpen, setAddWalletDialogOpen] = useState(false);
  const [isRegisterAgentDialogOpen, setRegisterAgentDialogOpen] = useState(false);

  const { rate, isLoading: isLoadingRate } = useRate();

  const [selectedAgentForDetails, setSelectedAgentForDetails] = useState<AIAgent | null>(null);
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);
  const [isMigrateDialogOpen, setMigrateDialogOpen] = useState(false);

  // Returns the grouped USD amount, or null when the CoinGecko rate is
  // unavailable so the caller can render a sensible fallback. Number math is
  // fine here — this is an approximate fiat estimate, not a ledger value.
  const formatUsdValue = (adaAmount: string) => {
    if (!rate || !adaAmount) return null;
    const ada = Number(adaAmount) / 1000000;
    return formatBalance((ada * rate).toFixed(2));
  };

  const totalBalanceUsd = formatUsdValue(totalBalance);

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
                Showing{' '}
                {selectedPaymentSource?.smartContractAddress
                  ? shortenAddress(selectedPaymentSource?.smartContractAddress)
                  : 'all payment sources'}
                {capabilities.canAdmin && (
                  <>
                    {' '}
                    ·{' '}
                    <Link href="/payment-sources" className="text-primary hover:underline">
                      Change source
                    </Link>
                  </>
                )}
              </p>
            </div>

            {capabilities.canAdmin && (
              <SetupV2Banner onMigrateClick={() => setMigrateDialogOpen(true)} />
            )}

            {capabilities.canAdmin && showMigrationHint && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/20">
                <div className="flex items-center gap-2 text-amber-950 dark:text-amber-100">
                  <ArrowUpRight className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                  <span>
                    This V1 payment source may have agents to migrate. Open migration to scan for V1
                    agents and compare them with V2.
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" onClick={() => setMigrateDialogOpen(true)}>
                    Scan and migrate
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsMigrationHintDismissed(true)}
                    className="text-amber-950/70 hover:bg-amber-100 hover:text-amber-950 dark:text-amber-100/70 dark:hover:bg-amber-900/30 dark:hover:text-amber-100"
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            <WelcomeBanner
              agentCount={totalAgentCount ?? agents.length}
              hasFundedWallet={hasFundedWallet}
              transactionCount={transactions.length}
              hasPaymentSource={!!selectedPaymentSource}
            />

            <Tabs
              tabs={DASHBOARD_TABS}
              activeTab={activeDashboardTab}
              onTabChange={setActiveDashboardTab}
            />

            {activeDashboardTab === OVERVIEW_TAB && (
              <div className="space-y-6">
                <div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {agentsSectionLoading || isLoadingAgentCount ? (
                      <StatCardSkeleton />
                    ) : (
                      <StatCard
                        label="Total AI agents"
                        index={0}
                        icon={<Bot className="h-4 w-4 text-blue-500" />}
                        accentColor="rgb(59, 130, 246)"
                      >
                        <div className="text-2xl font-semibold">{totalAgentCount ?? 0}</div>
                      </StatCard>
                    )}
                    {walletsSectionLoading ? (
                      <StatCardSkeleton />
                    ) : (
                      <StatCard
                        label={network === 'Mainnet' ? 'Total USDCx' : 'Total tUSDM'}
                        labelTooltip={network === 'Mainnet' ? '1 USDCx ~ $1' : '1 tUSDM ~ $1'}
                        index={1}
                        icon={<DollarSign className="h-4 w-4 text-green-500" />}
                        accentColor="rgb(34, 197, 94)"
                      >
                        <div className="text-2xl font-semibold flex items-center gap-1">
                          <span className="text-xs font-normal text-muted-foreground">$</span>
                          {formatSixDecimalAmount(totalUsdcxBalance)}
                        </div>
                      </StatCard>
                    )}
                    {walletsSectionLoading ? (
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
                            {formatSixDecimalAmount(totalBalance)}
                            <span className="text-xs font-normal text-muted-foreground">ADA</span>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {isLoadingRate
                              ? '...'
                              : totalBalanceUsd
                                ? `~ $${totalBalanceUsd}`
                                : '—'}
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
                            className="text-sm text-primary hover:underline flex items-center"
                          >
                            View all transactions
                            <ChevronRight size={14} />
                          </Link>
                        </>
                      </StatCard>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
                  <DashboardPanel
                    title="AI agents"
                    description="Recent agents on this payment source."
                    reserveListHeight={agentsSectionLoading || agents.length > 0}
                    footer={
                      capabilities.canPay ? (
                        <Button
                          size="sm"
                          className="gap-2"
                          onClick={() => setRegisterAgentDialogOpen(true)}
                        >
                          <Plus className="h-4 w-4" />
                          Register agent
                        </Button>
                      ) : undefined
                    }
                  >
                    {agentsSectionLoading ? (
                      <OverviewListScroll>
                        <AgentListSkeleton items={10} />
                      </OverviewListScroll>
                    ) : agents.length > 0 ? (
                      <OverviewListScroll>
                        <OverviewList>
                          {agents.map((agent, index) => (
                            <OverviewListItem key={agent.id} index={index}>
                              <button
                                type="button"
                                className={overviewWalletListRowClass}
                                onClick={() => setSelectedAgentForDetails(agent)}
                              >
                                <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
                                  <span className="truncate text-sm font-medium leading-5">
                                    {agent.name}
                                  </span>
                                  <p
                                    className={cn(
                                      overviewListSecondaryLineClass,
                                      !agent.description && 'invisible',
                                    )}
                                    aria-hidden={!agent.description}
                                  >
                                    {agent.description?.trim() || '\u00a0'}
                                  </p>
                                </div>
                                <div
                                  className={cn(
                                    overviewAgentPriceColumnClass,
                                    'self-center leading-4',
                                  )}
                                >
                                  {formatAgentListPrice(agent, network)}
                                </div>
                              </button>
                            </OverviewListItem>
                          ))}
                        </OverviewList>
                        <Pagination
                          size="compact"
                          className="border-t border-border/50 px-4 py-2"
                          hasMore={hasMoreAgents}
                          isLoading={isFetchingAgents && hasMoreAgents}
                          onLoadMore={() => void loadMoreAgents()}
                        />
                      </OverviewListScroll>
                    ) : (
                      <div className="flex flex-col justify-center px-4 py-8">
                        <EmptyState
                          title="No agents yet"
                          description={
                            capabilities.canPay
                              ? 'Register an agent to list it here.'
                              : 'Pay access is required to register agents.'
                          }
                        />
                      </div>
                    )}
                  </DashboardPanel>

                  <DashboardPanel
                    title="Wallets"
                    description="Balances for buying and selling wallets."
                    reserveListHeight={walletsSectionLoading || walletsList.length > 0}
                    headerExtra={
                      <RefreshButton
                        onRefresh={() => refetchWallets()}
                        isRefreshing={isLoadingWallets || isLoadingBalances}
                      />
                    }
                    footer={
                      capabilities.canAdmin ? (
                        <Button
                          size="sm"
                          className="gap-2"
                          onClick={() => setAddWalletDialogOpen(true)}
                        >
                          <Plus className="h-4 w-4" />
                          Add wallet
                        </Button>
                      ) : undefined
                    }
                  >
                    {walletsSectionLoading ? (
                      <OverviewListScroll>
                        <WalletListSkeleton rows={10} />
                      </OverviewListScroll>
                    ) : walletsList.length > 0 ? (
                      <DashboardWalletListSection
                        key={selectedPaymentSourceId ?? 'no-source'}
                        wallets={walletsList}
                        network={network}
                        canAdmin={capabilities.canAdmin}
                        onWalletClick={setSelectedWalletForDetails}
                      />
                    ) : (
                      <div className="flex flex-col justify-center px-4 py-8">
                        <EmptyState
                          title="No wallets yet"
                          description="Add a wallet to fund agents."
                        />
                      </div>
                    )}
                  </DashboardPanel>
                </div>
              </div>
            )}

            {activeDashboardTab === FINANCES_TAB && <FinancialReportSection />}
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
          refetchAgents();
        }}
      />

      <AIAgentDetailsDialog
        agent={selectedAgentForDetails}
        onClose={() => setSelectedAgentForDetails(null)}
        onSuccess={() => {
          refetchAgents();
        }}
      />

      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
      />

      <MigrateAgentsDialog
        open={isMigrateDialogOpen}
        onClose={() => setMigrateDialogOpen(false)}
        onSuccess={() => {
          refetchAgents();
          refetchWallets();
        }}
      />
    </>
  );
}
