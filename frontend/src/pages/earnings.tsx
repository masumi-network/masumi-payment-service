import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Button } from '@/components/ui/button';
import { Bot, ArrowRight } from 'lucide-react';
import { GetStaticProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';

export const getStaticProps: GetStaticProps = async () => {
  return {
    props: {},
  };
};

export default function EarningsPage() {
  return (
    <>
      <Head>
        <title>Earnings | Admin Interface</title>
      </Head>
      <MainLayout>
        <AnimatedPage>
          <div className="max-w-2xl space-y-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Earnings</h1>
              <p className="text-sm text-muted-foreground mt-2">
                Earnings are available per registered agent. This node does not show one combined
                earnings total on this page.
              </p>
            </div>

            <div className="rounded-lg border bg-card p-6 space-y-4">
              <h2 className="text-sm font-medium">How to view agent earnings</h2>
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                <li>Open AI Agents.</li>
                <li>
                  Select an agent and open its details, or choose the earnings action on a row.
                </li>
                <li>Open the Earnings tab to see totals and transactions for that agent.</li>
              </ol>
              <Button asChild>
                <Link href="/ai-agents" className="gap-2">
                  <Bot className="h-4 w-4" />
                  Go to AI Agents
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </AnimatedPage>
      </MainLayout>
    </>
  );
}
