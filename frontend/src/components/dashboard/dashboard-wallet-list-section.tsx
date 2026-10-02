import { ArrowLeftRight, PlusCircle } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { tableActionsInnerClass } from '@/components/ui/table-actions-column';
import { WalletTypeBadge } from '@/components/ui/wallet-type-badge';
import { WalletWithBalance } from '@/lib/queries/useWallets';
import { cn, formatSixDecimalAmount, shortenAddress } from '@/lib/utils';
import { getWalletTypeRowLabel } from '@/lib/wallet-type';

import { OVERVIEW_LIST_VISIBLE_ROWS, OverviewListScroll } from './dashboard-overview-section';

const DASHBOARD_PAGE_SIZE = 10;

/** Shared with loading skeleton. */
export const walletOverviewTableClassName = 'w-full min-w-[40rem] border-collapse text-left';

const thClass = 'px-3 py-2 text-left text-xs font-medium text-muted-foreground';
const tdClass = 'px-3 py-3 align-middle';

function WalletBalanceCell({
  wallet,
  network,
}: {
  wallet: WalletWithBalance;
  network: 'Preprod' | 'Mainnet';
}) {
  if (wallet.isLoadingBalance) {
    return <Spinner className="h-3 w-3" />;
  }

  return (
    <>
      <div className="tabular-nums">
        {wallet.isBalanceUnavailable ? '—' : formatSixDecimalAmount(wallet.balance || '0')}{' '}
        <span className="text-muted-foreground">ADA</span>
      </div>
      <div className="tabular-nums text-muted-foreground">
        {wallet.isBalanceUnavailable ? '—' : formatSixDecimalAmount(wallet.usdcxBalance || '0')}{' '}
        {network === 'Mainnet' ? 'USDCx' : 'tUSDM'}
      </div>
    </>
  );
}

export function DashboardWalletListSection({
  wallets,
  network,
  canAdmin,
  onWalletClick,
  onSwap,
  onTopUp,
}: {
  wallets: WalletWithBalance[];
  network: 'Preprod' | 'Mainnet';
  canAdmin: boolean;
  onWalletClick: (wallet: WalletWithBalance) => void;
  onSwap: (wallet: WalletWithBalance) => void;
  onTopUp: (wallet: WalletWithBalance) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(DASHBOARD_PAGE_SIZE);

  const visibleWallets = useMemo(() => wallets.slice(0, visibleCount), [wallets, visibleCount]);
  const hasMore = visibleCount < wallets.length;

  const loadMore = useCallback(() => {
    setVisibleCount((count) => Math.min(count + DASHBOARD_PAGE_SIZE, wallets.length));
  }, [wallets.length]);

  return (
    <OverviewListScroll className="overflow-auto">
      <table className={walletOverviewTableClassName}>
        <thead className="sticky top-0 z-20 bg-card [&_tr]:border-b [&_tr]:border-border/50">
          <tr>
            <th scope="col" className={thClass}>
              Type
            </th>
            <th scope="col" className={thClass}>
              Name
            </th>
            <th scope="col" className={thClass}>
              Address
            </th>
            <th scope="col" className={cn(thClass, 'text-right')}>
              Balance
            </th>
            {canAdmin ? (
              <th scope="col" className={cn(thClass, 'text-right')}>
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {visibleWallets.map((wallet, index) => (
            <tr
              key={wallet.id}
              className={cn(
                'border-b border-border/50 last:border-b-0 animate-fade-in opacity-0 transition-colors',
                canAdmin && 'cursor-pointer',
                wallet.LowBalanceSummary?.isLow
                  ? 'bg-amber-500/[0.07] hover:bg-amber-500/10'
                  : 'hover:bg-muted/30',
              )}
              style={{ animationDelay: `${Math.min(index, OVERVIEW_LIST_VISIBLE_ROWS) * 40}ms` }}
              onClick={() => canAdmin && onWalletClick(wallet)}
            >
              <td className={tdClass}>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <WalletTypeBadge type={wallet.type} />
                  {wallet.LowBalanceSummary?.isLow ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
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
                  ) : null}
                </div>
              </td>
              <td className={tdClass}>
                <div className="truncate text-sm font-medium">
                  {getWalletTypeRowLabel(wallet.type)}
                </div>
                <div
                  className="max-w-[9rem] truncate text-xs text-muted-foreground"
                  title={wallet.note?.trim() || undefined}
                >
                  {wallet.note?.trim() || 'Created by seeding'}
                </div>
              </td>
              <td className={tdClass}>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span
                    className="font-mono text-xs text-muted-foreground"
                    title={wallet.walletAddress}
                  >
                    {shortenAddress(wallet.walletAddress, 8)}
                  </span>
                  <CopyButton
                    value={wallet.walletAddress}
                    className="h-4 w-4 shrink-0 [&_svg]:size-3"
                  />
                </div>
              </td>
              <td className={cn(tdClass, 'text-right text-xs')}>
                <WalletBalanceCell wallet={wallet} network={network} />
              </td>
              {canAdmin ? (
                <td className={cn(tdClass, 'text-right')}>
                  <div className={tableActionsInnerClass}>
                    {wallet.network === 'Mainnet' ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Swap tokens"
                        className="h-8 w-8 shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSwap(wallet);
                        }}
                      >
                        <ArrowLeftRight className="h-4 w-4" />
                      </Button>
                    ) : null}
                    <Button
                      variant="muted"
                      size="sm"
                      className="h-8 shrink-0 gap-1 px-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTopUp(wallet);
                      }}
                    >
                      <PlusCircle className="h-3.5 w-3.5" />
                      Top Up
                    </Button>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
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
