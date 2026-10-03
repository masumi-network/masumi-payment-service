import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, Coins, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { useRailReadiness } from '@/lib/hooks/useRailReadiness';
import { hasPurchasingWalletOnEnabledNetworks, X402_ACCENT } from '@/lib/x402-rail';
import { getX402SetupProgress } from '@/lib/x402-setup';
import { cn } from '@/lib/utils';

const DISMISSED_KEY_PREFIX = 'masumi_x402_banner_dismissed_';

function getServerSnapshot() {
  return true;
}

function subscribe(callback: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}

/**
 * The one x402 setup prompt, shown above every x402 page until setup is done or dismissed
 * for the environment. It shows progress and has a single action that opens the setup
 * wizard, which resumes at the first open step, so setup never splits into side dialogs.
 */
export function X402SetupBanner() {
  const { network, authorized } = useAppContext();
  const { networks, isLoading: networksLoading } = useX402Networks({ silentErrors: true });
  const { wallets, isLoading: walletsLoading, isError: isWalletsError } = useX402Wallets();
  // Receiving is the backend's call: an enabled chain with an RPC URL and one facilitator.
  const {
    x402: readiness,
    isLoading: readinessLoading,
    isUnavailable: isReadinessUnavailable,
  } = useRailReadiness();

  const getSnapshot = useCallback(
    () =>
      typeof window === 'undefined'
        ? false
        : localStorage.getItem(DISMISSED_KEY_PREFIX + network) === 'true',
    [network],
  );
  const isDismissedFromStorage = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // Environment dismissed this session; the layout stays mounted across env switches.
  const [dismissedNetwork, setDismissedNetwork] = useState<string | null>(null);

  // Only an enabled chain can send a payment, so a wallet on a disabled chain doesn't count.
  const isPayingReady = useMemo(
    () => hasPurchasingWalletOnEnabledNetworks(wallets, networks),
    [wallets, networks],
  );
  const isReceivingReady = readiness?.isReady ?? false;
  const progress = getX402SetupProgress({ isReceivingReady, isPayingReady });

  // The hooks return empty lists before auth and while loading, which would read as
  // "nothing set up". Unknown readiness is not "not set up" either, so stay hidden.
  // A ready rail always has a chain, so an empty chain list there means the silent fetch
  // failed, and a failed wallet fetch would misreport paying as not done.
  const isUnknown =
    !authorized ||
    networksLoading ||
    walletsLoading ||
    readinessLoading ||
    isReadinessUnavailable ||
    isWalletsError ||
    (isReceivingReady && networks.length === 0);
  const isDismissed = isDismissedFromStorage || dismissedNetwork === network;
  if (isUnknown || progress.isComplete || isDismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY_PREFIX + network, 'true');
    } catch {
      // Private mode or a full quota: keep the dismissal in memory only.
    }
    setDismissedNetwork(network);
  };

  const items = [
    { label: 'Receive payments', isDone: isReceivingReady },
    { label: 'Pay other agents (optional)', isDone: isPayingReady },
  ];

  return (
    <section
      aria-labelledby="x402-setup-prompt-title"
      className={cn(
        'relative overflow-hidden rounded-xl border shadow-sm',
        isReceivingReady
          ? 'bg-card'
          : 'border-indigo-300/60 bg-gradient-to-br from-indigo-50 via-indigo-50/60 to-background dark:border-indigo-900/50 dark:from-indigo-950/30 dark:via-indigo-950/15 dark:to-background',
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={dismiss}
        className="absolute end-2 top-2 size-8 text-muted-foreground"
        aria-label={`Hide x402 setup for ${network}`}
      >
        <X className="size-4" aria-hidden />
      </Button>

      <div className="flex flex-col gap-4 p-5 pe-12 sm:p-6 sm:pe-12 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 ring-1 ring-indigo-500/30">
            <Coins className={cn('size-5', X402_ACCENT.icon)} aria-hidden />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 id="x402-setup-prompt-title" className="text-base font-semibold tracking-tight">
                {isReceivingReady ? 'Finish x402 setup' : `Set up x402 payments on ${network}`}
              </h2>
              <span className="text-xs font-medium tabular-nums text-muted-foreground">
                {progress.completedCount} of {progress.totalCount} done
              </span>
            </div>
            <p className="max-w-2xl text-pretty text-sm text-muted-foreground">
              {isReceivingReady
                ? 'Your agents can take payments. Add a Purchasing wallet so they can also pay other agents.'
                : 'Let your agents get paid, and pay other agents, in stablecoins on EVM chains.'}
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {items.map((item) => (
                <li
                  key={item.label}
                  className={cn(
                    'flex items-center gap-1.5',
                    item.isDone ? 'text-green-700 dark:text-green-500' : 'text-muted-foreground',
                  )}
                >
                  {item.isDone ? (
                    <Check className="size-3.5" aria-hidden />
                  ) : (
                    <span aria-hidden className="size-3.5 rounded-full border border-current" />
                  )}
                  {item.label}
                  <span className="sr-only">{item.isDone ? '(done)' : '(not done)'}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <Button
          asChild
          variant={isReceivingReady ? 'outline' : 'default'}
          className="group shrink-0 gap-2 pe-3.5"
        >
          <Link href={`/x402-setup?network=${network}`}>
            {progress.actionLabel}
            <ArrowRight
              className="size-4 transition-[translate] duration-150 group-hover:translate-x-0.5"
              aria-hidden
            />
          </Link>
        </Button>
      </div>
    </section>
  );
}
