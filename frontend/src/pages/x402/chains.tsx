import Head from 'next/head';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { ChainsTab } from '@/components/x402/ChainsTab';
import { X402SetupGuide } from '@/components/x402/X402SetupGuide';
import { useAppContext } from '@/lib/contexts/AppContext';

export default function X402ChainsPage() {
  const { capabilities } = useAppContext();

  return (
    <MainLayout>
      <Head>
        <title>x402 Chains | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">x402 Chains</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              EVM chains available to the x402 payment rail.
            </p>
          </div>

          {capabilities.canAdmin && <X402SetupGuide />}

          <ChainsTab />
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
