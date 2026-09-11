import Head from 'next/head';
import { ExternalLink } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { PaymentsTab } from '@/components/x402/PaymentsTab';
import { X402AdminPageExtras } from '@/components/x402/X402AdminPageExtras';

export default function X402PaymentsPage() {
  return (
    <MainLayout>
      <Head>
        <title>x402 Transactions | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">x402 Transactions</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Transaction activity for the x402 (EVM) rail.{' '}
              <a
                href={MASUMI_DEV_HUB_URL}
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

          <PaymentsTab />
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
