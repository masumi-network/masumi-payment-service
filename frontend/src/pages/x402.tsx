import { useState } from 'react';
import Head from 'next/head';
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

export default function X402Page() {
  const [activeTab, setActiveTab] = useState<TabName>('Chains');

  return (
    <MainLayout>
      <Head>
        <title>x402 | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">x402</h1>
            <p className="text-sm text-muted-foreground">
              Manage the EVM payment rail — chains, managed wallets, spend budgets and payment
              activity.
            </p>
          </div>

          <X402SetupGuide />

          <Tabs
            tabs={TAB_NAMES.map((name) => ({ name }))}
            activeTab={activeTab}
            onTabChange={(name) => setActiveTab(name as TabName)}
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
