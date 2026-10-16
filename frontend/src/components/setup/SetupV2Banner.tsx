import { useCallback, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, Info, Wand2, X } from 'lucide-react';
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

export function SetupV2Banner({ onMigrateClick: _onMigrateClick }: SetupV2BannerProps) {
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
  if (!hasLegacyOnly) return null;
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
        'border-border/80 bg-gradient-to-br from-muted/40 via-background to-background',
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

      <div className="absolute -top-12 -right-12 h-40 w-40 rounded-full bg-primary/5 blur-3xl pointer-events-none" />

      <div className="relative px-6 py-6 sm:px-8 sm:py-7 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-4 flex-1 min-w-0">
          <div className="shrink-0 flex h-12 w-12 items-center justify-center rounded-xl ring-1 bg-muted/60 ring-border/60">
            <Info className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">
                Optional V2 upgrade for {network}
              </h2>
              <Badge variant="outline" className="font-medium">
                V2
              </Badge>
              <Badge variant="secondary" className="font-medium">
                {network}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Your existing V1 payment source stays active. V2 adds updated registry metadata, zero
              fees, and weighted admin signatures — run the guided setup when you are ready to
              migrate agents.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 shrink-0">
          <Button asChild size="lg" variant="outline" className="gap-2 btn-hover-lift group">
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
