import Head from 'next/head';
import { ExternalLink } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { WalletsTab } from '@/components/x402/WalletsTab';
import { X402AdminPageExtras } from '@/components/x402/X402AdminPageExtras';
import { useAppContext } from '@/lib/contexts/AppContext';

export default function X402WalletsPage() {
  const { capabilities } = useAppContext();

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

          <X402AdminPageExtras />

          <WalletsTab />
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
