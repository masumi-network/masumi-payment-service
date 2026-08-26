import Head from 'next/head';
import Link from 'next/link';
import {
  ArrowUpDown,
  BellRing,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Wallet,
} from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import { StatCardSkeleton } from '@/components/skeletons/StatCardSkeleton';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { StatCard } from '@/components/ui/stat-card';
import { X402SetupGuide } from '@/components/x402/X402SetupGuide';
import type { X402PaymentAttempt } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { formatDateTime } from '@/lib/format-date';
import {
  useAvailableX402Networks,
  useX402DashboardBalances,
  useX402DashboardCounts,
  useX402DashboardLowBalanceCount,
  useX402DashboardRecentPayments,
  useX402Wallets,
} from '@/lib/hooks/useX402';
import { formatX402Amount, groupDigits, shortenAddress } from '@/lib/utils';

const STATUS_VARIANT: Record<X402PaymentAttempt['status'], BadgeProps['variant']> = {
  PaymentRequired: 'pending',
  Verified: 'processing',
  Settled: 'success',
  Failed: 'destructive',
  Replayed: 'secondary',
};

const DIRECTION_LABEL: Record<X402PaymentAttempt['direction'], string> = {
  InboundVerify: 'Receive · verify',
  InboundSettle: 'Receive · settle',
  OutboundPayment: 'Pay',
};

export default function X402DashboardPage() {
  const { capabilities, selectedX402ChainId } = useAppContext();
  const { networks, isLoading: isLoadingNetworks } = useAvailableX402Networks({
    silentErrors: true,
  });
  const selectedChain = networks.find((network) => network.id === selectedX402ChainId) ?? null;
  const caip2Network = selectedChain?.caip2Id;

  const walletsQuery = useX402Wallets(!!selectedChain, undefined, selectedChain?.id);
  const countsQuery = useX402DashboardCounts(caip2Network);
  const balancesQuery = useX402DashboardBalances(walletsQuery.wallets, caip2Network);
  const recentQuery = useX402DashboardRecentPayments(caip2Network);
  const lowBalanceQuery = useX402DashboardLowBalanceCount(caip2Network);

  const isRefreshing =
    walletsQuery.isRefetching ||
    countsQuery.isRefetching ||
    balancesQuery.isRefetching ||
    recentQuery.isRefetching ||
    lowBalanceQuery.isRefetching;

  const refresh = async () => {
    await Promise.all([
      walletsQuery.refetch(),
      countsQuery.refetch(),
      balancesQuery.refetch(),
      recentQuery.refetch(),
      ...(capabilities.canAdmin ? [lowBalanceQuery.refetch()] : []),
    ]);
  };

  return (
    <MainLayout>
      <Head>
        <title>x402 Dashboard | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Overview of x402 wallets, balances, and transactions.{' '}
                <a
                  href="https://www.masumi.network/dev/masumi"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline"
                >
                  Docs
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
              {selectedChain && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Showing {selectedChain.displayName} · {selectedChain.caip2Id}
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
              )}
            </div>
            <RefreshButton
              variant="with-text"
              onRefresh={refresh}
              isRefreshing={isRefreshing}
              disabled={!selectedChain}
            />
          </div>

          {capabilities.canAdmin && <X402SetupGuide />}

          {isLoadingNetworks ? (
            <div className="flex justify-center py-16">
              <Spinner size={24} />
            </div>
          ) : !selectedChain ? (
            <div className="rounded-lg border">
              <EmptyState
                title="No x402 chain selected"
                description={
                  capabilities.canAdmin
                    ? 'Select an x402 payment source above or configure one under Payment Sources.'
                    : 'This API key cannot access an x402 chain. Ask an admin to update its chain limit.'
                }
                action={
                  capabilities.canAdmin ? (
                    <Link
                      className="text-sm font-medium text-primary hover:underline"
                      href="/payment-sources"
                    >
                      Open Payment Sources
                    </Link>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {walletsQuery.isLoading ? (
                  <StatCardSkeleton />
                ) : (
                  <StatCard
                    label="Managed wallets"
                    index={0}
                    icon={<Wallet className="h-4 w-4 text-orange-500" />}
                    accentColor="rgb(249, 115, 22)"
                  >
                    <div className="text-2xl font-semibold">
                      {walletsQuery.isError ? '—' : walletsQuery.wallets.length}
                    </div>
                    {walletsQuery.isError ? (
                      <p className="text-xs text-muted-foreground">Wallet list unavailable</p>
                    ) : (
                      <Link
                        href="/x402/wallets"
                        className="flex items-center text-sm text-primary hover:underline"
                      >
                        View wallets <ChevronRight className="h-3.5 w-3.5" />
                      </Link>
                    )}
                  </StatCard>
                )}

                {countsQuery.isLoading ? (
                  <StatCardSkeleton />
                ) : (
                  <StatCard
                    label="Transactions"
                    index={1}
                    icon={<ArrowUpDown className="h-4 w-4 text-purple-500" />}
                    accentColor="rgb(168, 85, 247)"
                  >
                    <div className="text-2xl font-semibold">
                      {countsQuery.isError ? '—' : countsQuery.counts?.transactions}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {countsQuery.isError
                        ? 'Count unavailable'
                        : `${countsQuery.counts?.byStatus.Settled ?? 0} settled · ${countsQuery.counts?.byStatus.Failed ?? 0} failed`}
                    </p>
                  </StatCard>
                )}

                {countsQuery.isLoading ? (
                  <StatCardSkeleton />
                ) : (
                  <StatCard
                    label="Successful settlements"
                    index={2}
                    icon={<CheckCircle2 className="h-4 w-4 text-green-500" />}
                    accentColor="rgb(34, 197, 94)"
                  >
                    <div className="text-2xl font-semibold">
                      {countsQuery.isError ? '—' : countsQuery.counts?.successfulSettlements}
                    </div>
                  </StatCard>
                )}

                {capabilities.canAdmin &&
                  (lowBalanceQuery.isLoading ? (
                    <StatCardSkeleton />
                  ) : (
                    <StatCard
                      label="Low-balance alerts"
                      index={3}
                      icon={<BellRing className="h-4 w-4 text-amber-500" />}
                      accentColor="rgb(245, 158, 11)"
                    >
                      <div className="text-2xl font-semibold">
                        {lowBalanceQuery.isError ? '—' : lowBalanceQuery.count}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {lowBalanceQuery.isError
                          ? 'Status unavailable'
                          : 'Active rules below threshold'}
                      </p>
                    </StatCard>
                  ))}
              </div>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <section className="rounded-lg border p-6">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-medium">Balances</h2>
                      <p className="text-sm text-muted-foreground">
                        Totals across managed wallets on {selectedChain.displayName}.
                      </p>
                    </div>
                    <Link
                      href="/x402/wallets"
                      className="flex shrink-0 items-center text-sm text-primary hover:underline"
                    >
                      Wallets <ChevronRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>

                  {balancesQuery.failedReadCount > 0 && (
                    <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
                      {balancesQuery.failedReadCount} balance{' '}
                      {balancesQuery.failedReadCount === 1 ? 'result is' : 'results are'}{' '}
                      unavailable. Available totals remain visible.
                    </div>
                  )}

                  {walletsQuery.isLoading || balancesQuery.isLoading ? (
                    <div className="flex justify-center py-12">
                      <Spinner size={24} />
                    </div>
                  ) : walletsQuery.isError ? (
                    <EmptyState
                      title="Wallets unavailable"
                      description="The managed wallet list could not be loaded. Try refreshing the dashboard."
                    />
                  ) : balancesQuery.balances.length === 0 ? (
                    <EmptyState
                      title={
                        walletsQuery.wallets.length === 0
                          ? 'No managed wallets'
                          : 'No balances available'
                      }
                      description={
                        walletsQuery.wallets.length === 0
                          ? 'Create a wallet for this chain to track its balances.'
                          : 'The chain RPC did not return a readable balance.'
                      }
                    />
                  ) : (
                    <div className="space-y-2">
                      {balancesQuery.balances.map((balance) => (
                        <div
                          key={`${balance.caip2Network}:${balance.asset}`}
                          className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{balance.symbol}</p>
                            <p
                              className="truncate font-mono text-xs text-muted-foreground"
                              title={
                                balance.asset === 'native' ? 'Native gas token' : balance.asset
                              }
                            >
                              {balance.asset === 'native'
                                ? 'Native gas token'
                                : shortenAddress(balance.asset, 8)}
                              {' · '}
                              {balance.walletCount}{' '}
                              {balance.walletCount === 1 ? 'wallet' : 'wallets'}
                            </p>
                          </div>
                          <span className="shrink-0 font-mono text-sm font-medium">
                            {formatX402Amount(balance.amount, balance.decimals)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="rounded-lg border p-6">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-medium">Recent transactions</h2>
                      <p className="text-sm text-muted-foreground">
                        Newest activity on this chain.
                      </p>
                    </div>
                    <Link
                      href="/x402/payments"
                      className="flex shrink-0 items-center text-sm text-primary hover:underline"
                    >
                      All transactions <ChevronRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>

                  {recentQuery.isLoading ? (
                    <div className="flex justify-center py-12">
                      <Spinner size={24} />
                    </div>
                  ) : recentQuery.isError ? (
                    <EmptyState
                      title="Transactions unavailable"
                      description="The transaction list could not be loaded. Try refreshing the dashboard."
                    />
                  ) : recentQuery.attempts.length === 0 ? (
                    <EmptyState
                      title="No transaction activity"
                      description="x402 payment attempts will appear here."
                    />
                  ) : (
                    <div className="divide-y">
                      {recentQuery.attempts.map((attempt) => (
                        <div
                          key={attempt.id}
                          className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium">
                                {DIRECTION_LABEL[attempt.direction]}
                              </span>
                              <Badge variant={STATUS_VARIANT[attempt.status]}>
                                {attempt.status}
                              </Badge>
                            </div>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {formatDateTime(attempt.createdAt)} ·{' '}
                              <span className="font-mono" title={attempt.asset}>
                                {shortenAddress(attempt.asset, 6)}
                              </span>
                            </p>
                          </div>
                          <span className="shrink-0 font-mono text-sm">
                            {groupDigits(attempt.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
