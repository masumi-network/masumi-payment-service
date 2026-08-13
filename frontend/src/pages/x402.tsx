import { useCallback, useEffect, useMemo } from 'react';
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
import { useAppContext } from '@/lib/contexts/AppContext';
import { hasEvmChainLimit } from '@/lib/permissions';
import { useX402NetworksForSession } from '@/lib/hooks/useX402';

const ADMIN_TAB_NAMES = ['Chains', 'Wallets', 'Budgets', 'Alerts', 'Payments'] as const;
// Budgets is read-at-pay, write-at-admin: a pay key sees the allowances governing
// its own spend (the API pins the filter to the calling key) but gets no
// create/edit controls. Read keys cannot spend, so the tab stays out of their list.
const PAY_TAB_NAMES = ['Wallets', 'Budgets', 'Payments'] as const;
// Read keys get the wallet list and payment history. Both are read-level, as is the
// chain projection; the wallet lifecycle (the only path returning key material) is
// admin and gated inside the tab.
const READ_TAB_NAMES = ['Wallets', 'Payments'] as const;
type TabName = (typeof ADMIN_TAB_NAMES)[number];

function isTabName(value: unknown, allowed: readonly string[]): value is TabName {
  return typeof value === 'string' && allowed.includes(value);
}

export default function X402Page() {
  const router = useRouter();
  const { capabilities } = useAppContext();
  const tabNames = capabilities.canAdmin
    ? ADMIN_TAB_NAMES
    : capabilities.canPay
      ? PAY_TAB_NAMES
      : READ_TAB_NAMES;
  const defaultTab = tabNames[0];
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

  // Drive the active tab from the URL so tabs are deep-linkable and shareable, and so an
  // empty state can route the operator to the prerequisite tab (e.g. "Create a wallet first").
  const activeTab: TabName = useMemo(() => {
    const fromQuery = router.query.tab;
    return isTabName(fromQuery, tabNames) ? fromQuery : defaultTab;
  }, [router.query.tab, tabNames, defaultTab]);

  const setActiveTab = useCallback(
    (name: string) => {
      router.replace({ pathname: '/x402', query: { tab: name } }, undefined, { shallow: true });
    },
    [router],
  );

  useEffect(() => {
    // Canonicalize any tab param the session cannot use (a pay key landing on an
    // admin tab link, a stale bookmark). Compare against undefined rather than
    // truthiness so `?tab=` is rewritten too instead of sticking in the URL.
    if (!isTabName(router.query.tab, tabNames) && router.query.tab !== undefined) {
      router.replace({ pathname: '/x402', query: { tab: defaultTab } }, undefined, {
        shallow: true,
      });
    }
  }, [router, tabNames, defaultTab]);

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
              {capabilities.canAdmin
                ? 'Manage the EVM payment rail: chains, managed wallets, spend budgets, balance alerts and payment activity.'
                : capabilities.canPay
                  ? 'View and manage EVM wallets and payment activity for chains your key can access.'
                  : 'View EVM wallets and x402 payment activity for chains your key can access. Managing wallets needs admin access.'}{' '}
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

          <Tabs
            tabs={tabNames.map((name) => ({ name }))}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />

          <div className="pt-2">
            {activeTab === 'Chains' && capabilities.canAdmin && <ChainsTab />}
            {activeTab === 'Wallets' && <WalletsTab />}
            {activeTab === 'Budgets' && capabilities.canPay && <BudgetsTab />}
            {activeTab === 'Alerts' && capabilities.canAdmin && <AlertsTab />}
            {activeTab === 'Payments' && <PaymentsTab />}
          </div>
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
