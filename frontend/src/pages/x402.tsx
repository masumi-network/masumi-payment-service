import { useCallback, useMemo } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { ExternalLink } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Tabs } from '@/components/ui/tabs';
import { ChainsTab } from '@/components/x402/ChainsTab';
import { WalletsTab } from '@/components/x402/WalletsTab';
import { BudgetsTab } from '@/components/x402/BudgetsTab';
import { PaymentsTab } from '@/components/x402/PaymentsTab';
import { AlertsTab } from '@/components/x402/AlertsTab';
import { X402SetupGuide } from '@/components/x402/X402SetupGuide';

const TAB_NAMES = ['Chains', 'Wallets', 'Budgets', 'Alerts', 'Payments'] as const;
type TabName = (typeof TAB_NAMES)[number];

function isTabName(value: unknown): value is TabName {
  return typeof value === 'string' && (TAB_NAMES as readonly string[]).includes(value);
}

export default function X402Page() {
  const router = useRouter();

  // Drive the active tab from the URL so tabs are deep-linkable and shareable, and so an
  // empty state can route the operator to the prerequisite tab (e.g. "Create a wallet first").
  const activeTab: TabName = useMemo(() => {
    const fromQuery = router.query.tab;
    return isTabName(fromQuery) ? fromQuery : 'Chains';
  }, [router.query.tab]);

  const setActiveTab = useCallback(
    (name: string) => {
      router.replace({ pathname: '/x402', query: { tab: name } }, undefined, { shallow: true });
    },
    [router],
  );

  return (
    <MainLayout>
      <Head>
        <title>x402 | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">x402</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Manage the EVM payment rail: chains, managed wallets, spend budgets, balance alerts
              and payment activity.{' '}
              <a
                href="https://docs.masumi.network"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline"
              >
                Docs
                <ExternalLink className="h-3 w-3" />
              </a>
            </p>
          </div>

          <X402SetupGuide />

          <Tabs
            tabs={TAB_NAMES.map((name) => ({ name }))}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />

          <div className="pt-2">
            {activeTab === 'Chains' && <ChainsTab />}
            {activeTab === 'Wallets' && <WalletsTab />}
            {activeTab === 'Budgets' && <BudgetsTab />}
            {activeTab === 'Alerts' && <AlertsTab />}
            {activeTab === 'Payments' && <PaymentsTab />}
          </div>
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
