import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import { GetStaticProps } from 'next';
import Head from 'next/head';
import { Button } from '@/components/ui/button';
import { ChevronRight, Plus } from 'lucide-react';
import { shortenAddress } from '@/lib/utils';
import { useState, useMemo } from 'react';
import { RegistryEntry } from '@/lib/api/generated';
import { useAgents } from '@/lib/queries/useAgents';
import { useWallets, WalletWithBalance } from '@/lib/queries/useWallets';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import Link from 'next/link';
import { AddWalletDialog } from '@/components/wallets/AddWalletDialog';
import { RegisterAIAgentDialog } from '@/components/ai-agents/RegisterAIAgentDialog';
//import { SwapDialog } from '@/components/wallets/SwapDialog';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { useRate } from '@/lib/hooks/useRate';
import { StatCardSkeleton } from '@/components/skeletons/StatCardSkeleton';
import { AgentListSkeleton } from '@/components/skeletons/AgentListSkeleton';
import { WalletListSkeleton } from '@/components/skeletons/WalletListSkeleton';
import { Spinner } from '@/components/ui/spinner';
//import { FaExchangeAlt } from 'react-icons/fa';
import formatBalance from '@/lib/formatBalance';
import { WalletTypeBadge } from '@/components/ui/wallet-type-badge';
import { useTransactions } from '@/lib/hooks/useTransactions';
import { AIAgentDetailsDialog } from '@/components/ai-agents/AIAgentDetailsDialog';
import { WalletDetailsDialog } from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';
import { TESTUSDM_CONFIG, getUsdmConfig } from '@/lib/constants/defaultWallets';
import {
  MockPaymentDialog,
  MockPurchaseDialog,
  FullCycleDialog,
} from '@/components/testing';

type AIAgent = RegistryEntry;

export const getStaticProps: GetStaticProps = async () => {
  return {
    props: {},
  };
};

export default function Overview() {
  const { network, selectedPaymentSource } = useAppContext();

  const queryClient = useQueryClient();
  const { newTransactionsCount, isLoading: isLoadingTransactions } =
    useTransactions();

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
    totalUsdmBalance: totalUsdmBalanceValue,
    isLoading: isLoadingWallets,
  } = useWallets();

  const totalBalance = useMemo(
    () => totalBalanceValue || '0',
    [totalBalanceValue],
  );
  const totalUsdmBalance = useMemo(
    () => totalUsdmBalanceValue || '0',
    [totalUsdmBalanceValue],
  );
  const isLoadingBalances = isLoadingWallets;

  // Refetch functions for after mutations
  const refetchAgents = () => {
    queryClient.invalidateQueries({ queryKey: ['agents'] });
  };

  const refetchWallets = () => {
    queryClient.invalidateQueries({ queryKey: ['wallets'] });
  };
  const [isAddWalletDialogOpen, setAddWalletDialogOpen] = useState(false);
  const [isRegisterAgentDialogOpen, setRegisterAgentDialogOpen] =
    useState(false);

  //const [selectedWalletForSwap, setSelectedWalletForSwap] =
  //  useState<WalletWithBalance | null>(null);

  const [selectedWalletForTopup, setSelectedWalletForTopup] =
    useState<WalletWithBalance | null>(null);
  const { rate, isLoading: isLoadingRate } = useRate();

  const [selectedAgentForDetails, setSelectedAgentForDetails] =
    useState<AIAgent | null>(null);
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);

  // Testing dialogs state
  const [isMockPaymentDialogOpen, setMockPaymentDialogOpen] = useState(false);
  const [isMockPurchaseDialogOpen, setMockPurchaseDialogOpen] = useState(false);
  const [isFullCycleDialogOpen, setFullCycleDialogOpen] = useState(false);

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
        <div className="mb-8">
          <div className="flex justify-between items-center mb-4">
            <h1 className="text-3xl font-semibold mb-1">Dashboard</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Overview of your AI agents, wallets, and transactions.
          </p>
          <p className="text-xs text-muted-foreground mt-5">
            Showing data for{' '}
            {selectedPaymentSource?.smartContractAddress
              ? shortenAddress(selectedPaymentSource?.smartContractAddress)
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
            {isLoadingAgents ? (
              <StatCardSkeleton />
            ) : (
              <div className="border rounded-lg p-6">
                <div className="text-sm text-muted-foreground mb-2">
                  Total AI agents
                </div>
                <div className="text-2xl font-semibold">
                  {agents.length}
                  {hasMoreAgents ? '+' : ''}
                </div>
              </div>
            )}
            {isLoadingWallets || isLoadingBalances ? (
              <StatCardSkeleton />
            ) : (
              <div className="border rounded-lg p-6">
                <div className="text-sm text-muted-foreground mb-2">
                  Total USDM
                </div>
                <div className="text-2xl font-semibold flex items-center gap-1">
                  <span className="text-xs font-normal text-muted-foreground">
                    $
                  </span>
                  {formatBalance(
                    (parseInt(totalUsdmBalance) / 1000000)
                      .toFixed(2)
                      ?.toString(),
                  ) ?? ''}
                </div>
              </div>
            )}
            {isLoadingWallets || isLoadingBalances ? (
              <StatCardSkeleton />
            ) : (
              <div className="border rounded-lg p-6">
                <div className="text-sm text-muted-foreground mb-2">
                  Total ada balance
                </div>
                <div className="flex flex-col gap-2">
                  <div className="text-2xl font-semibold flex items-center gap-1">
                    {formatBalance(
                      (parseInt(totalBalance) / 1000000).toFixed(2)?.toString(),
                    ) ?? ''}
                    <span className="text-xs font-normal text-muted-foreground">
                      ADA
                    </span>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {isLoadingRate && !totalUsdmBalance
                      ? '...'
                      : `~ $${formatBalance(formatUsdValue(totalBalance))}`}
                  </div>
                </div>
              </div>
            )}
            {isLoadingTransactions ? (
              <StatCardSkeleton />
            ) : (
              <div className="border rounded-lg p-6">
                <div className="text-sm text-muted-foreground mb-2">
                  New Transactions
                </div>
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
              </div>
            )}
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
                <AgentListSkeleton items={3} />
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
                                if (unit === getUsdmConfig(network).fullAssetId)
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
                  {hasMoreAgents && (
                    <div className="flex justify-center pt-4">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => loadMoreAgents()}
                        disabled={!hasMoreAgents || isLoadingAgents}
                      >
                        Load more
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

          <div className="border rounded-lg p-6">
            <div className="">
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
                  <WalletListSkeleton rows={2} />
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
                        {walletsList.map((wallet) => (
                          <tr
                            key={wallet.id}
                            className="border-b last:border-0 cursor-pointer hover:bg-muted/10"
                            onClick={() => setSelectedWalletForDetails(wallet)}
                          >
                            <td className="py-3 px-2">
                              <WalletTypeBadge type={wallet.type} />
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
                                {wallet.isLoadingBalance ? (
                                  <Spinner className="h-3 w-3" />
                                ) : (
                                  <>
                                    {formatBalance(
                                      (
                                        parseInt(wallet.balance || '0') /
                                        1000000
                                      )
                                        .toFixed(2)
                                        ?.toString(),
                                    )}{' '}
                                    <span className="text-xs text-muted-foreground">
                                      ADA
                                    </span>
                                  </>
                                )}
                              </div>
                              <div className="text-xs flex items-center gap-1">
                                {!wallet.isLoadingBalance && (
                                  <>
                                    {formatBalance(
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
                                  </>
                                )}
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
            </div>
            <div className="flex items-center justify-between">
              <Button
                className="flex items-center gap-2"
                onClick={() => setAddWalletDialogOpen(true)}
              >
                <Plus className="h-4 w-4" />
                Add wallet
              </Button>
            </div>
          </div>

          {/* Testing Tools Card */}
          <div className="border rounded-lg p-6">
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">Testing Tools</span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Create mock payments and purchases for development and testing.
            </p>
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                onClick={() => setMockPaymentDialogOpen(true)}
              >
                Create Mock Payment
              </Button>
              <Button
                variant="outline"
                onClick={() => setMockPurchaseDialogOpen(true)}
              >
                Create Mock Purchase
              </Button>
              <Button onClick={() => setFullCycleDialogOpen(true)}>
                Full Payment Cycle
              </Button>
            </div>
          </div>
        </div>
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
          refetchWallets();
        }}
      />

      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
      />

      {/* Testing Dialogs */}
      <MockPaymentDialog
        open={isMockPaymentDialogOpen}
        onClose={() => setMockPaymentDialogOpen(false)}
      />
      
      <MockPurchaseDialog
        open={isMockPurchaseDialogOpen}
        onClose={() => setMockPurchaseDialogOpen(false)}
      />
      
      <FullCycleDialog
        open={isFullCycleDialogOpen}
        onClose={() => setFullCycleDialogOpen(false)}
      />
    </>
  );
}
