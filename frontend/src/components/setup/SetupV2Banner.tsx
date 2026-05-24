import { useCallback, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, Sparkles, Wand2, ShieldCheck, ArrowUpRight, X } from 'lucide-react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { cn } from '@/lib/utils';

const DISMISSED_KEY_PREFIX = 'masumi_setup_v2_banner_dismissed_';

function getServerSnapshot() {
  return true;
}

function subscribe(callback: () => void) {
  // useSyncExternalStore only invokes subscribe on the client, but guard
  // defensively so any future SSR-rendering path doesn't crash on `window`.
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}

interface SetupV2BannerProps {
  onMigrateClick?: () => void;
}

export function SetupV2Banner({ onMigrateClick }: SetupV2BannerProps) {
  const { network } = useAppContext();
  const { paymentSources, isLoading } = usePaymentSourceExtendedAll();

  // Stable per-network getSnapshot so useSyncExternalStore doesn't see a new
  // function on every render. Primitive return value (boolean) is reference-
  // equal across calls, so React won't re-render in a loop.
  const getSnapshot = useCallback(
    () =>
      typeof window === 'undefined'
        ? false
        : localStorage.getItem(DISMISSED_KEY_PREFIX + network) === 'true',
    [network],
  );
  const isDismissedFromStorage = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [dismissed, setDismissed] = useState(false);

  const currentNetworkSources = paymentSources.filter((ps) => ps.network === network);
  const hasAnySource = currentNetworkSources.length > 0;
  const hasV2 = currentNetworkSources.some(isV2PaymentSource);
  const hasLegacyOnly = hasAnySource && !hasV2;

  if (isLoading) return null;
  if (hasV2) return null;
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

  const setupHref = `/setup?network=${network}`;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border-2 shadow-md animate-fade-in-up',
        hasLegacyOnly
          ? 'border-amber-300/60 bg-gradient-to-br from-amber-50 via-amber-50 to-background dark:border-amber-900/50 dark:from-amber-950/30 dark:via-amber-950/15 dark:to-background'
          : 'border-primary/30 bg-gradient-to-br from-primary/5 via-primary/[0.03] to-background',
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

      <div className="absolute -top-12 -right-12 h-40 w-40 rounded-full bg-primary/10 blur-3xl pointer-events-none" />

      <div className="relative px-6 py-6 sm:px-8 sm:py-7 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-4 flex-1 min-w-0">
          <div
            className={cn(
              'shrink-0 flex h-12 w-12 items-center justify-center rounded-xl ring-1',
              hasLegacyOnly ? 'bg-amber-500/15 ring-amber-500/30' : 'bg-primary/15 ring-primary/30',
            )}
          >
            {hasLegacyOnly ? (
              <ShieldCheck className="h-6 w-6 text-amber-600 dark:text-amber-400" />
            ) : (
              <Sparkles className="h-6 w-6 text-primary" />
            )}
          </div>
          <div className="space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">
                {hasLegacyOnly
                  ? `Set up V2 to keep going on ${network}`
                  : `One-time setup for ${network}`}
              </h2>
              <Badge variant="outline" className="font-medium">
                V2
              </Badge>
              <Badge variant="secondary" className="font-medium">
                {network}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground max-w-2xl">
              {hasLegacyOnly
                ? 'V2 is the default for new agents — zero fees, updated registry metadata, and weighted admin signatures. Run the quick setup, then migrate your existing agents below.'
                : 'A guided 3-step wizard generates wallets, configures Blockfrost, and creates the V2 payment source so you can register your first AI agent in minutes.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 shrink-0">
          {hasLegacyOnly && onMigrateClick && (
            <Button
              variant="outline"
              size="lg"
              onClick={onMigrateClick}
              className="gap-2 btn-hover-lift"
            >
              <ArrowUpRight className="h-4 w-4" />
              Migrate agents
            </Button>
          )}
          <Button asChild size="lg" className="gap-2 btn-hover-lift group">
            <Link href={setupHref}>
              <Wand2 className="h-4 w-4" />
              Start V2 setup
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
