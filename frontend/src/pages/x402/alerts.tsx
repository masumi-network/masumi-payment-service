import Head from 'next/head';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { AlertsTab } from '@/components/x402/AlertsTab';
import { X402SetupGuide } from '@/components/x402/X402SetupGuide';
import { useAppContext } from '@/lib/contexts/AppContext';

export default function X402AlertsPage() {
  const { capabilities } = useAppContext();

  return (
    <MainLayout>
      <Head>
        <title>x402 Alerts | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">x402 Alerts</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Low-balance alerts for managed wallets on the x402 rail.
            </p>
          </div>

          {capabilities.canAdmin && <X402SetupGuide />}

          <AlertsTab />
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
