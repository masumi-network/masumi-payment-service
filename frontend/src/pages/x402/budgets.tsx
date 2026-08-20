import Head from 'next/head';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { BudgetsTab } from '@/components/x402/BudgetsTab';
import { X402SetupGuide } from '@/components/x402/X402SetupGuide';
import { useAppContext } from '@/lib/contexts/AppContext';
import { hasEvmChainLimit } from '@/lib/permissions';
import { useX402NetworksForSession } from '@/lib/hooks/useX402';

export default function X402BudgetsPage() {
  const { capabilities } = useAppContext();
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
        <title>x402 Budgets | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">x402 Budgets</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Per-API-key spend limits for managed wallets on the x402 rail.
            </p>
          </div>

          {capabilities.canAdmin && <X402SetupGuide />}

          {showChainLimitHint && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
              This API key has no EVM chains in its chain limit, so no x402 chains or payment
              activity can be shown. An admin can add the chain ids to the key.
            </div>
          )}

          <BudgetsTab />
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
