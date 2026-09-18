import { useCallback, useMemo, useState } from 'react';

import { CopyButton } from '@/components/ui/copy-button';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { WalletTypeIcon } from '@/components/ui/wallet-type-badge';
import { WalletWithBalance } from '@/lib/queries/useWallets';
import { cn, formatSixDecimalAmount, shortenAddress } from '@/lib/utils';
import { getWalletTypeLabel } from '@/lib/wallet-type';

import {
  OverviewList,
  OverviewListScroll,
  OverviewListItem,
  overviewListSecondaryLineClass,
  overviewWalletListRowClass,
  overviewWalletBalanceColumnClass,
  overviewWalletTypeColumnClass,
} from './dashboard-overview-section';

const DASHBOARD_PAGE_SIZE = 10;

export function DashboardWalletListSection({
  wallets,
  network,
  canAdmin,
  onWalletClick,
}: {
  wallets: WalletWithBalance[];
  network: 'Preprod' | 'Mainnet';
  canAdmin: boolean;
  onWalletClick: (wallet: WalletWithBalance) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(DASHBOARD_PAGE_SIZE);

  const visibleWallets = useMemo(() => wallets.slice(0, visibleCount), [wallets, visibleCount]);
  const hasMore = visibleCount < wallets.length;

  const loadMore = useCallback(() => {
    setVisibleCount((count) => Math.min(count + DASHBOARD_PAGE_SIZE, wallets.length));
  }, [wallets.length]);

  return (
    <OverviewListScroll>
      <OverviewList>
        {visibleWallets.map((wallet, index) => (
          <OverviewListItem key={wallet.id} index={index}>
            <button
              type="button"
              disabled={!canAdmin}
              className={cn(
                overviewWalletListRowClass,
                wallet.LowBalanceSummary?.isLow && 'bg-amber-500/[0.07]',
              )}
              onClick={() => canAdmin && onWalletClick(wallet)}
            >
              <span className={overviewWalletTypeColumnClass}>
                <WalletTypeIcon type={wallet.type} className="h-3.5 w-3.5 shrink-0 opacity-80" />
                {getWalletTypeLabel(wallet.type)}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex w-full items-baseline gap-4">
                  <div className="flex min-w-0 flex-1 items-center gap-0.5">
                    <span
                      className="truncate font-mono text-sm font-medium leading-5"
                      title={wallet.walletAddress}
                    >
                      {shortenAddress(wallet.walletAddress, 12)}
                    </span>
                    <CopyButton
                      value={wallet.walletAddress}
                      className="h-4 w-4 shrink-0 [&_svg]:size-3"
                    />
                    {wallet.LowBalanceSummary?.isLow ? (
                      <span
                        aria-hidden="true"
                        className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                        title="Low balance"
                      />
                    ) : null}
                  </div>
                  <div className={overviewWalletBalanceColumnClass}>
                    {wallet.isLoadingBalance ? (
                      <Spinner className="ml-auto h-3 w-3" />
                    ) : (
                      <div className="leading-4">
                        {wallet.isBalanceUnavailable
                          ? '—'
                          : formatSixDecimalAmount(wallet.balance || '0')}{' '}
                        <span className="text-muted-foreground">ADA</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex w-full gap-4">
                  <p
                    className={cn(
                      overviewListSecondaryLineClass,
                      'min-w-0 flex-1',
                      !wallet.note?.trim() && 'invisible',
                    )}
                    aria-hidden={!wallet.note?.trim()}
                  >
                    {wallet.note?.trim() || '\u00a0'}
                  </p>
                  <div className={cn(overviewWalletBalanceColumnClass, 'leading-4')}>
                    {wallet.isLoadingBalance ? null : (
                      <div className="text-muted-foreground">
                        {wallet.isBalanceUnavailable
                          ? '—'
                          : formatSixDecimalAmount(wallet.usdcxBalance || '0')}{' '}
                        {network === 'Mainnet' ? 'USDCx' : 'tUSDM'}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </button>
          </OverviewListItem>
        ))}
      </OverviewList>
      <Pagination
        size="compact"
        className="border-t border-border/50 px-4 py-2"
        hasMore={hasMore}
        isLoading={false}
        onLoadMore={loadMore}
      />
    </OverviewListScroll>
  );
}
