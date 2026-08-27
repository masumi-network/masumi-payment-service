import Head from 'next/head';
import { ExternalLink } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { WalletsTab } from '@/components/x402/WalletsTab';
import { X402SetupGuide } from '@/components/x402/X402SetupGuide';
import { useAppContext } from '@/lib/contexts/AppContext';
import { hasEvmChainLimit } from '@/lib/permissions';
import { useX402NetworksForSession } from '@/lib/hooks/useX402';

export default function X402WalletsPage() {
  const { capabilities } = useAppContext();
  // A non-admin key only sees chains listed in its own CAIP-2 limit, so an empty
  // rail here usually means the key was provisioned without any EVM chain rather
  // than the rail being unconfigured. Say which, instead of rendering nothing.
  const { networks: sessionChains, isLoading: chainsLoading } = useX402NetworksForSession({
    silentErrors: true,
  });
  const showChainLimitHint =
    !capabilities.canAdmin &&
    !chainsLoading &&
    sessionChains.length === 0 &&
    !hasEvmChainLimit(capabilities.chainIdLimit);

  return (
    <MainLayout>
      <Head>
        <title>x402 Wallets | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">x402 Wallets</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {capabilities.canAdmin
                ? 'Managed EVM wallets for the x402 payment rail. Keys are encrypted at rest.'
                : 'EVM wallets for chains your key can access.'}{' '}
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
          </div>

          {capabilities.canAdmin && <X402SetupGuide />}

          {showChainLimitHint && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
              This API key has no EVM chains in its chain limit, so no x402 chains or payment
              activity can be shown. An admin can add the chain ids to the key.
            </div>
          )}

          <WalletsTab />
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
