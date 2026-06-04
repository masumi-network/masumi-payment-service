import { useCallback, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, Coins, X } from 'lucide-react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useX402Networks } from '@/lib/hooks/useX402';
import { isX402SetUpForEnv } from '@/lib/x402-rail';
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
 * First-run prompt for the x402 (EVM) rail, mirroring SetupV2Banner. Shown when the
 * active environment has no usable EVM chain configured. Dismissible per-environment.
 */
export function X402SetupBanner() {
  const { network } = useAppContext();
  const { networks, isLoading } = useX402Networks({ silentErrors: true });

  const getSnapshot = useCallback(
    () =>
      typeof window === 'undefined'
        ? false
        : localStorage.getItem(DISMISSED_KEY_PREFIX + network) === 'true',
    [network],
  );
  const isDismissedFromStorage = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [dismissed, setDismissed] = useState(false);

  if (isLoading) return null;
  if (isX402SetUpForEnv(networks, network)) return null;
  if (isDismissedFromStorage || dismissed) return null;

  const handleDismiss = () => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(DISMISSED_KEY_PREFIX + network, 'true');
      } catch {
        // Safari private mode / quota exceeded — fall back to in-memory only.
      }
    }
    setDismissed(true);
  };

  const setupHref = `/x402-setup?network=${network}`;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border-2 shadow-md animate-fade-in-up',
        'border-indigo-300/60 bg-gradient-to-br from-indigo-50 via-indigo-50/60 to-background',
        'dark:border-indigo-900/50 dark:from-indigo-950/30 dark:via-indigo-950/15 dark:to-background',
      )}
    >
      <button
        type="button"
        onClick={handleDismiss}
        className="absolute top-3 right-3 text-muted-foreground hover:text-foreground transition-colors z-10"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="absolute -top-12 -right-12 h-40 w-40 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

      <div className="relative px-6 py-6 sm:px-8 sm:py-7 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-4 flex-1 min-w-0">
          <div className="shrink-0 flex h-12 w-12 items-center justify-center rounded-xl ring-1 bg-indigo-500/15 ring-indigo-500/30">
            <Coins className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div className="space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">
                Set up the x402 (EVM) rail for {network}
              </h2>
              <Badge variant="outline" className="font-medium">
                EVM
              </Badge>
              <Badge variant="secondary" className="font-medium">
                {network}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Let your agents pay — and get paid by — other agents over EVM chains using
              stablecoins. A guided setup creates a managed wallet, enables a chain, and
              (optionally) funds a budget.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 shrink-0">
          <Button asChild size="lg" className="gap-2 btn-hover-lift group">
            <Link href={setupHref}>
              <Coins className="h-4 w-4" />
              Set up x402 (EVM)
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
