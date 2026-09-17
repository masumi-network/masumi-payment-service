import Head from 'next/head';
import { GetStaticProps } from 'next';
import { useCallback, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { COSIGN_DASHBOARD_URL } from '@/lib/cosign-demo';

export const getStaticProps: GetStaticProps = async () => {
  return {
    props: {},
  };
};

// MAS-596 demo only. Exchain's spec keeps their JavaScript out of Masumi pages,
// so the shipped Protected surface reads the same data through our backend.
export default function CosignDemo() {
  const [isFrameLoaded, setIsFrameLoaded] = useState(false);
  const handleFrameLoad = useCallback(() => setIsFrameLoaded(true), []);

  return (
    <>
      <Head>
        <title>Co-sign (Demo) | Admin Interface</title>
      </Head>
      <MainLayout>
        <AnimatedPage>
          <div className="flex flex-col gap-4 h-[calc(100vh-180px)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Co-sign (Demo)</h1>
                <p className="text-sm text-muted-foreground">
                  Quorum decisions for the preprod guarded smart wallet, from the co-signer&apos;s
                  hosted dashboard. Embedded for the demo only.
                </p>
              </div>
              {COSIGN_DASHBOARD_URL && (
                <Button variant="outline" size="sm" asChild>
                  <a href={COSIGN_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">
                    Open in new tab
                    <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
                  </a>
                </Button>
              )}
            </div>

            {COSIGN_DASHBOARD_URL ? (
              <div className="flex-1 border rounded-lg overflow-hidden relative">
                {!isFrameLoaded && (
                  <Skeleton className="absolute inset-0 w-full h-full rounded-none" />
                )}
                <iframe
                  src={COSIGN_DASHBOARD_URL}
                  title="Co-sign dashboard"
                  className="w-full h-full"
                  sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  referrerPolicy="no-referrer"
                  onLoad={handleFrameLoad}
                />
              </div>
            ) : (
              <EmptyState
                title="No co-sign dashboard configured"
                description="Set NEXT_PUBLIC_EXCHAIN_DASHBOARD_URL for both the frontend build and the backend, then rebuild the admin UI."
              />
            )}
          </div>
        </AnimatedPage>
      </MainLayout>
    </>
  );
}
