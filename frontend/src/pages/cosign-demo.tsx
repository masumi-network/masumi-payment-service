import Head from 'next/head';
import { GetStaticProps } from 'next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { postExchainReadToken } from '@/lib/api/generated';
import { COSIGN_DASHBOARD_URL } from '@/lib/cosign-demo';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';

export const getStaticProps: GetStaticProps = async () => {
  return {
    props: {},
  };
};

/** Exchain's frame posts this about two minutes before its read token expires. */
const TOKEN_EXPIRING = /^exchain:read-token-expir/;

// MAS-596 demo only. Exchain's spec keeps their JavaScript out of Masumi pages,
// so the shipped Protected surface reads the same data through our backend.
// Here their page runs inside its own frame; the only contact is postMessage.
export default function CosignDemo() {
  const { apiClient } = useAppContext();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [isFrameLoaded, setIsFrameLoaded] = useState(false);
  const handleFrameLoad = useCallback(() => setIsFrameLoaded(true), []);

  const mintReadToken = useCallback(async () => {
    const response = await handleApiCall(
      () => postExchainReadToken({ client: apiClient, body: {} }),
      // No token is expected against the local mock (it issues none), and the
      // frame then shows the configured page directly, so stay quiet here.
      { onError: () => undefined },
    );
    return response?.data?.data ?? null;
  }, [apiClient]);

  // Minted once: the frame URL must stay stable, because a new src reloads the
  // page. Later tokens reach the frame through postMessage instead.
  const { data: initial, isLoading } = useQuery({
    queryKey: ['exchain-read-token'],
    queryFn: mintReadToken,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // Exchain: the page for our wallet, token included. Without a token (the local
  // mock, or Exchain not configured on this node) frame the configured URL as is.
  const frameUrl = initial?.url ?? COSIGN_DASHBOARD_URL;

  useEffect(() => {
    if (!initial) return;
    const exchainOrigin = new URL(initial.url).origin;
    const onMessage = async (event: MessageEvent) => {
      // Only our own frame, served by Exchain, may ask for a token.
      if (event.source !== frameRef.current?.contentWindow || event.origin !== exchainOrigin)
        return;
      const type: unknown = (event.data as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !TOKEN_EXPIRING.test(type)) return;
      const fresh = await mintReadToken();
      if (fresh == null) return;
      frameRef.current?.contentWindow?.postMessage(
        { type: 'exchain:read-token', token: fresh.token },
        exchainOrigin,
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [initial, mintReadToken]);

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
                  The preprod guarded smart wallet as Exchain sees it: its mandate and every
                  approved and refused payment. Embedded for the demo only.
                </p>
              </div>
              {frameUrl && (
                <Button variant="outline" size="sm" asChild>
                  <a href={frameUrl} target="_blank" rel="noopener noreferrer">
                    Open in new tab
                    <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
                  </a>
                </Button>
              )}
            </div>

            {isLoading ? (
              <Skeleton className="flex-1 w-full rounded-lg" />
            ) : frameUrl ? (
              <div className="flex-1 border rounded-lg overflow-hidden relative">
                {!isFrameLoaded && (
                  <Skeleton className="absolute inset-0 w-full h-full rounded-none" />
                )}
                <iframe
                  ref={frameRef}
                  src={frameUrl}
                  title="Exchain co-sign page"
                  className="w-full h-full"
                  sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  referrerPolicy="no-referrer"
                  onLoad={handleFrameLoad}
                />
              </div>
            ) : (
              <EmptyState
                title="No co-sign dashboard configured"
                description="Set NEXT_PUBLIC_EXCHAIN_DASHBOARD_URL for both the frontend build and the backend, then rebuild the admin UI. For Exchain, also set EXCHAIN_WALLET_ID and EXCHAIN_COSIGN_API_KEY on the backend."
              />
            )}
          </div>
        </AnimatedPage>
      </MainLayout>
    </>
  );
}
