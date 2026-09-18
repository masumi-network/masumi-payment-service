import Head from 'next/head';
import { GetStaticProps } from 'next';
import { useRouter } from 'next/router';
import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { postWalletGuardReadToken } from '@/lib/api/generated';
import { extractApiPayload } from '@/lib/api-response';
import { useAppContext } from '@/lib/contexts/AppContext';
import { COSIGN_DASHBOARD_URL, parseCosignDashboardUrl } from '@/lib/cosign-demo';

const READ_TOKEN_REFRESH_MS = 10 * 60 * 1000;

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
  const { apiClient } = useAppContext();
  const { query } = useRouter();
  const walletId = typeof query.walletId === 'string' ? query.walletId : null;
  const { data: walletDashboardUrl } = useQuery({
    queryKey: ['cosignReadToken', walletId],
    enabled: walletId != null,
    refetchInterval: READ_TOKEN_REFRESH_MS,
    queryFn: async () => {
      const res = await postWalletGuardReadToken({
        client: apiClient,
        body: { walletId: walletId ?? '' },
      });
      return parseCosignDashboardUrl(extractApiPayload(res)?.url);
    },
  });
  const dashboardUrl = walletId != null ? (walletDashboardUrl ?? null) : COSIGN_DASHBOARD_URL;

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
              {dashboardUrl && (
                <Button variant="outline" size="sm" asChild>
                  <a href={dashboardUrl} target="_blank" rel="noopener noreferrer">
                    Open in new tab
                    <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
                  </a>
                </Button>
              )}
            </div>

            {dashboardUrl ? (
              <div className="flex-1 border rounded-lg overflow-hidden relative">
                {!isFrameLoaded && (
                  <Skeleton className="absolute inset-0 w-full h-full rounded-none" />
                )}
                <iframe
                  src={dashboardUrl}
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
                description="Set NEXT_PUBLIC_EXCHAIN_DASHBOARD_URL for both the frontend build and the backend, then rebuild the admin UI. Open this page with ?walletId=<guarded purchasing wallet> for the wallet-scoped view."
              />
            )}
          </div>
        </AnimatedPage>
      </MainLayout>
    </>
  );
}
