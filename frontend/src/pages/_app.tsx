import { AppProvider } from '@/lib/contexts/AppContext';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import '@/styles/globals.css';
import '@/styles/styles.scss';
import type { AppProps } from 'next/app';
import { useAppContext } from '@/lib/contexts/AppContext';
import { toast, ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { ApiKeyDialog } from '@/components/api-keys/ApiKeyDialog';
import { getHealth, getApiKeyStatus } from '@/lib/api/generated';
import { ThemeProvider, useTheme } from '@/lib/contexts/ThemeContext';
import { SidebarProvider } from '@/lib/contexts/SidebarContext';
import { QueryProvider } from '@/lib/contexts/QueryProvider';
import { AgentDetailsDialogProvider } from '@/lib/contexts/AgentDetailsDialogContext';
import { Spinner } from '@/components/ui/spinner';
import { RouteProgressBar } from '@/components/layout/RouteProgressBar';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { handleApiCall } from '@/lib/utils';
import { useDynamicFavicon } from '@/hooks/useDynamicFavicon';
import { TooltipProvider } from '@/components/ui/tooltip';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { useX402Networks } from '@/lib/hooks/useX402';
import { chainsForEnv } from '@/lib/x402-rail';

function App({ Component, pageProps, router }: AppProps) {
  return (
    <ThemeProvider>
      <QueryProvider>
        <AppProvider>
          <SidebarProvider>
            <TooltipProvider delayDuration={200}>
              <ThemedApp Component={Component} pageProps={pageProps} router={router} />
            </TooltipProvider>
          </SidebarProvider>
        </AppProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}

function ToastWrapper() {
  const { theme } = useTheme();
  return createPortal(
    <ToastContainer
      position="top-right"
      autoClose={3000}
      hideProgressBar={false}
      newestOnTop
      closeOnClick
      rtl={false}
      pauseOnFocusLoss
      draggable
      pauseOnHover
      theme={theme === 'dark' ? 'dark' : 'light'}
    />,
    document.body,
  );
}

function ThemedApp({ Component, pageProps, router }: AppProps) {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [isMobileWarningDismissed, setIsMobileWarningDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const {
    apiClient,
    signOut,
    apiKey,
    setAuthorized,
    updateApiKey,
    network,
    setNetwork,
    authorized,
    isSetupMode,
    activeRail,
  } = useAppContext();

  // Add dynamic favicon functionality
  useDynamicFavicon();

  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 1024);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const { mainnetPaymentSources, preprodPaymentSources, isLoading } = usePaymentSourceExtendedAll();
  const { networks: x402Networks, isLoading: x402Loading } = useX402Networks({
    silentErrors: true,
  });

  useEffect(() => {
    if (isLoading) return;
    const currentNetworkPaymentSources =
      network === 'Mainnet' ? mainnetPaymentSources : preprodPaymentSources;
    // Pages accessible even without payment sources (shown in setup sidebar)
    const setupAccessiblePages = ['/api-keys', '/developers', '/settings', '/x402-setup'];
    // The x402 rail stands alone, so don't force Cardano setup for it. Two strengths:
    // - `x402MaybeStandalone` stays true WHILE the chain list is loading, so an EVM
    //   operator on a shared page (e.g. /ai-agents) isn't bounced to Cardano /setup during
    //   the load window. Once loaded with no chains it becomes false and setup proceeds.
    // - `x402Confirmed` requires loaded data, gating the Cardano-only -> /x402 redirect so a
    //   stale rail never redirects before its availability is known.
    const x402ChainCount = chainsForEnv(x402Networks, network).length;
    const x402MaybeStandalone = activeRail === 'x402' && (x402Loading || x402ChainCount > 0);
    const x402Confirmed = activeRail === 'x402' && !x402Loading && x402ChainCount > 0;
    if (apiKey && isHealthy && currentNetworkPaymentSources.length === 0 && !x402MaybeStandalone) {
      const protectedPages = ['/', '/ai-agents', '/inbox-agents', '/wallets', '/transactions'];
      if (protectedPages.includes(router.pathname)) {
        router.replace('/setup?network=' + (network === 'Mainnet' ? 'Mainnet' : 'Preprod'));
      }
    }
    // If setup mode is active (persisted from before reload), redirect back to setup
    // but allow access to pages shown in the setup sidebar
    if (
      apiKey &&
      isHealthy &&
      isSetupMode &&
      router.pathname !== '/setup' &&
      !setupAccessiblePages.includes(router.pathname)
    ) {
      router.replace('/setup?network=' + (network === 'Mainnet' ? 'Mainnet' : 'Preprod'));
    }
    // Full context switch: on the x402 (EVM) rail, Cardano-only pages aren't in the
    // sidebar, so bounce direct/deep-link navigations to them back to the x402 hub.
    // Guard on confirmed x402 availability so a stale persisted rail (e.g. after the
    // env's chains were removed) can't trap the user away from Cardano pages — the
    // sidebar selector downgrades the rail to Cardano in that case.
    if (apiKey && isHealthy && !isSetupMode && x402Confirmed) {
      const cardanoOnlyPages = ['/', '/inbox-agents', '/wallets', '/transactions', '/invoices'];
      if (cardanoOnlyPages.includes(router.pathname)) {
        router.replace('/x402');
      }
    }
  }, [
    apiKey,
    isHealthy,
    router,
    isLoading,
    network,
    mainnetPaymentSources,
    preprodPaymentSources,
    isSetupMode,
    activeRail,
    x402Loading,
    x402Networks,
  ]);

  useEffect(() => {
    // Cancellation guards a run that outlives this effect (deps changed,
    // unmount): a stale run finishing after signOut must not re-authorize
    // the user with the key they just signed out of.
    let cancelled = false;

    const init = async () => {
      const response = await handleApiCall(() => getHealth({ client: apiClient }), {
        onError: (error: any) => {
          console.error('Health check failed:', error);
          if (!cancelled) setIsHealthy(false);
        },
        errorMessage: 'Health check failed',
      });
      if (cancelled) return;

      if (!response) {
        setIsHealthy(false);
        return;
      }

      const hexedKey = localStorage.getItem('payment_api_key');
      if (!hexedKey) {
        setIsHealthy(true);
        setAuthorized(false);
        return;
      }

      const storedApiKey = Buffer.from(hexedKey, 'hex').toString('utf-8');
      apiClient.setConfig({
        headers: {
          token: storedApiKey,
        },
      });
      const apiKeyStatus = await handleApiCall(() => getApiKeyStatus({ client: apiClient }), {
        onError: (error: any) => {
          console.error('API key status check failed:', error);
          if (!cancelled) {
            setIsHealthy(true);
            setAuthorized(false);
          }
        },
        errorMessage: 'API key validation failed',
      });
      // Re-read the stored key: signOut() clears it without changing this
      // effect's deps, and authorizing from the stale value would sign the
      // user straight back in.
      if (cancelled || localStorage.getItem('payment_api_key') !== hexedKey) return;

      if (!apiKeyStatus) {
        setIsHealthy(true);
        setAuthorized(false);
        return;
      }

      // Check if the API key has admin permission
      const permission = apiKeyStatus.data?.data?.permission;
      if (!permission || permission !== 'Admin') {
        setIsHealthy(true);
        toast.error('Unauthorized access');
        signOut();
        return;
      }
      setAuthorized(true);
      updateApiKey(storedApiKey);
      setIsHealthy(true);
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [apiClient, signOut, setAuthorized, updateApiKey]);

  // Sync network from URL when query.network changes (e.g. after shallow replace on setup page).
  // Intentionally omit `network` from deps so that when we set network in the sidebar dialog,
  // this effect does not re-run with stale router.query and overwrite the new value.
  useEffect(() => {
    const networkParam = router.query.network as string;
    if (!networkParam) return;
    if (networkParam.toLowerCase() === 'mainnet') {
      setNetwork('Mainnet');
    } else if (networkParam.toLowerCase() === 'preprod') {
      setNetwork('Preprod');
    }
  }, [router.query.network, setNetwork]);

  if (isHealthy === null) {
    return (
      <div className="flex items-center justify-center bg-background text-foreground fixed top-0 left-0 w-full h-full z-50">
        <div className="text-center space-y-4">
          <Spinner size={20} addContainer />
        </div>
      </div>
    );
  }

  if (!authorized && apiKey) {
    return (
      <div className="flex items-center justify-center bg-background text-foreground fixed top-0 left-0 w-full h-full z-50">
        <div className="text-center space-y-4">
          <div className="text-lg text-destructive">Unauthorized</div>
          <div className="text-sm text-muted-foreground">
            Your API key is invalid or does not have admin permissions. Please sign out and sign in
            with an admin API key.
          </div>
          <Button
            variant="destructive"
            className="text-sm"
            onClick={() => {
              signOut();
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  if (isHealthy === false) {
    return (
      <div className="flex items-center justify-center bg-background text-foreground fixed top-0 left-0 w-full h-full z-50">
        <div className="text-center space-y-4">
          <div className="text-lg text-destructive">System Unavailable</div>
          <div className="text-sm text-muted-foreground">
            Unable to connect to required services. Please try again later.
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <RouteProgressBar />
      {isMobile && !isMobileWarningDismissed && (
        <div
          role="status"
          className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100"
        >
          <div className="flex-1">
            The admin interface is designed for desktop. On a narrow screen some tables and dialogs
            may be hard to use.{' '}
            <Link
              href="https://docs.masumi.io"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              Learn more
            </Link>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Dismiss small screen warning"
            className="shrink-0 -my-1 text-amber-950/70 hover:bg-amber-100 hover:text-amber-950 dark:text-amber-100/70 dark:hover:bg-amber-900/30 dark:hover:text-amber-100"
            onClick={() => setIsMobileWarningDismissed(true)}
          >
            Dismiss
          </Button>
        </div>
      )}
      {apiKey ? (
        <AgentDetailsDialogProvider>
          <Component {...pageProps} />
        </AgentDetailsDialogProvider>
      ) : (
        <ApiKeyDialog />
      )}
      {mounted && <ToastWrapper />}
    </>
  );
}

export default App;
