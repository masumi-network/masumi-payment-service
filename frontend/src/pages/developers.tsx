import { MainLayout } from '@/components/layout/MainLayout';
import Head from 'next/head';
import { Button } from '@/components/ui/button';
import { Tabs } from '@/components/ui/tabs';
import { ExternalLink, CreditCard, ShoppingCart, ArrowRightLeft } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { GetStaticProps } from 'next';
import { MockPaymentDialog, MockPurchaseDialog, FullCycleDialog } from '@/components/testing';
import { InputSchemaValidator } from '@/components/developers/InputSchemaValidator';

export const getStaticProps: GetStaticProps = async () => {
  return {
    props: {},
  };
};

const TABS = [{ name: 'Testing' }, { name: 'Schema Validator' }, { name: 'OpenAPI' }];

export default function Developers() {
  const [activeTab, setActiveTab] = useState('Testing');
  const [isIframeLoaded, setIsIframeLoaded] = useState(false);
  const handleIframeLoad = useCallback(() => setIsIframeLoaded(true), []);
  const [isPaymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [isPurchaseDialogOpen, setPurchaseDialogOpen] = useState(false);
  const [isFullCycleDialogOpen, setFullCycleDialogOpen] = useState(false);

  return (
    <>
      <Head>
        <title>Developers | Admin Interface</title>
      </Head>
      <MainLayout>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-bold">Developers</h1>
            <p className="text-sm text-muted-foreground mt-1">
              API documentation and testing tools.
            </p>
          </div>

          <Tabs tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />

          {activeTab === 'Testing' && (
            <div className="space-y-6 animate-fade-in-up opacity-0">
              <div className="grid gap-4 md:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setPaymentDialogOpen(true)}
                  className="group border rounded-lg p-6 text-left transition-all duration-200 hover:shadow-md hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-muted group-hover:bg-primary/10 transition-colors duration-200">
                      <CreditCard className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors duration-200" />
                    </div>
                    <h2 className="font-medium">Test Payment</h2>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Create a single test payment to simulate a seller-side payment request.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setPurchaseDialogOpen(true)}
                  className="group border rounded-lg p-6 text-left transition-all duration-200 hover:shadow-md hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-muted group-hover:bg-primary/10 transition-colors duration-200">
                      <ShoppingCart className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors duration-200" />
                    </div>
                    <h2 className="font-medium">Test Purchase</h2>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Create a single test purchase to simulate a buyer-side purchase request.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setFullCycleDialogOpen(true)}
                  className="group border rounded-lg p-6 text-left transition-all duration-200 hover:shadow-md hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-muted group-hover:bg-primary/10 transition-colors duration-200">
                      <ArrowRightLeft className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors duration-200" />
                    </div>
                    <h2 className="font-medium">Full Payment Cycle</h2>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Run a complete payment-to-purchase cycle in one step for end-to-end testing.
                  </p>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'Schema Validator' && (
            <div className="animate-fade-in-up opacity-0">
              <InputSchemaValidator />
            </div>
          )}

          {activeTab === 'OpenAPI' && (
            <div className="flex flex-col h-[calc(100vh-280px)] animate-fade-in-up opacity-0">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Interactive API documentation powered by Swagger UI.
                </p>
                <Button variant="outline" size="sm" asChild>
                  <a href="/docs" target="_blank" rel="noopener noreferrer">
                    Open in new tab
                    <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
                  </a>
                </Button>
              </div>
              <div className="flex-1 border rounded-lg overflow-hidden relative">
                {!isIframeLoaded && <Skeleton className="absolute inset-0 w-full h-full rounded-none" />}
                <iframe src="/docs" className="w-full h-full" title="OpenAPI Documentation" onLoad={handleIframeLoad} />
              </div>
            </div>
          )}
        </div>
      </MainLayout>

      <MockPaymentDialog open={isPaymentDialogOpen} onClose={() => setPaymentDialogOpen(false)} />

      <MockPurchaseDialog
        open={isPurchaseDialogOpen}
        onClose={() => setPurchaseDialogOpen(false)}
      />

      <FullCycleDialog open={isFullCycleDialogOpen} onClose={() => setFullCycleDialogOpen(false)} />
    </>
  );
}
