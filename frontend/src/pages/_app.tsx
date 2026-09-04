import { AppProvider } from '@/lib/contexts/AppContext';
import { useEffect, useRef, useState } from 'react';
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
import { useX402NetworksForSession } from '@/lib/hooks/useX402';
import { chainsForEnv } from '@/lib/x402-rail';
import { capabilitiesFromApiKeyStatus, isAdminOnlyPath, isPayOnlyPath } from '@/lib/permissions';
import { decryptFromStorage } from '@/lib/secure-storage';
import { hasLegacyOnlyPaymentSources, isV2PaymentSource } from '@/lib/payment-source-type';
import { MASUMI_DOCUMENTATION_URL } from '@/lib/masumi-links';
import {
  deniedPathFallback,
  isSetupPath,
  setupPath,
  shouldRestoreX402Rail,
  X402_DASHBOARD_PATH,
} from '@/lib/x402-navigation';

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
  const isRouteChanging = useRef(false);
  // Previous rail, so an explicit switch away from x402 can be told apart from a deep
  // link that arrives already on the Cardano rail. Updated by the recorder effect
  // below, which is declared BEFORE the guard effect so the transition is recorded
  // before the guard reads it on the same render.
  const previousRailRef = useRef<'cardano' | 'x402'>('cardano');
  // Pathname the user switched away from the EVM rail on. The restore stays suppressed
  // for that pathname until the pending navigation actually lands somewhere else.
  const suppressRailRestoreOnPathRef = useRef<string | null>(null);
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [isMobileWarningDismissed, setIsMobileWarningDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const {
    apiClient,
    signOut,
    apiKey,
    setAuthorized,
    setCapabilities,
    updateApiKey,
    network,
    setNetwork,
    authorized,
    capabilities,
    isSetupMode,
    setIsSetupMode,
    activeRail,
    setActiveRail,
  } = useAppContext();

  // Add dynamic favicon functionality
  useDynamicFavicon();

  useEffect(() => {
    const onStart = () => {
      isRouteChanging.current = true;
    };
    const onEnd = () => {
      isRouteChanging.current = false;
    };
    router.events.on('routeChangeStart', onStart);
    router.events.on('routeChangeComplete', onEnd);
    router.events.on('routeChangeError', onEnd);
    return () => {
      router.events.off('routeChangeStart', onStart);
      router.events.off('routeChangeComplete', onEnd);
      router.events.off('routeChangeError', onEnd);
    };
  }, [router.events]);

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
  const { networks: x402Networks, isLoading: x402Loading } = useX402NetworksForSession({
    silentErrors: true,
  });

  // Record a switch off the EVM rail before the guard effect below can act on it.
  //
  // Declared first and free of early returns, so the transition is observed on every
  // run: folding this into the guard effect meant a run that bailed early (still
  // loading, admin-only redirect) consumed the transition, and the next run could no
  // longer tell the user's switch from a deep link.
  //
  // Keyed by pathname rather than by a single render, because `router.push` has not
  // landed yet at this point. Next emits `routeChangeStart` only after an
  // `await matchesMiddleware(...)` inside push, so `isRouteChanging` is still false
  // here; without this key, picking a Cardano source on /x402/wallets was reverted to
  // x402 and the pending navigation to '/' was then bounced on to /x402/dashboard.
  useEffect(() => {
    const switchedAway = previousRailRef.current === 'x402' && activeRail === 'cardano';
    previousRailRef.current = activeRail;
    if (switchedAway) {
      suppressRailRestoreOnPathRef.current = router.pathname;
    } else if (suppressRailRestoreOnPathRef.current !== router.pathname) {
      suppressRailRestoreOnPathRef.current = null;
    }
  }, [activeRail, router.pathname]);

  useEffect(() => {
    // Non-admins cannot open admin-only routes — do this before waiting on
    // payment sources to load, or deep-links would mount those pages and fire admin APIs first.
    if (apiKey && isHealthy && !capabilities.canAdmin && isAdminOnlyPath(router.pathname)) {
      const x402Fallback = deniedPathFallback(
        router.pathname,
        router.pathname === '/payment-sources' && activeRail === 'x402' ? X402_DASHBOARD_PATH : '',
      );
      if (x402Fallback) {
        router.replace(x402Fallback);
        return;
      }
      if (isLoading) {
        router.replace('/');
        return;
      }
      const sources = network === 'Mainnet' ? mainnetPaymentSources : preprodPaymentSources;
      router.replace(sources.length > 0 ? '/' : '/developers');
      return;
    }

    // Read-only keys cannot use pay-authenticated surfaces (x402, webhooks).
    // Gate the whole route: the underlying 401s are swallowed by the query layer,
    // so leaving the page mounted shows an empty state rather than a permission error.
    if (
      apiKey &&
      isHealthy &&
      !capabilities.canAdmin &&
      !capabilities.canPay &&
      isPayOnlyPath(router.pathname)
    ) {
      router.replace(deniedPathFallback(router.pathname, '/'));
      return;
    }

    if (isLoading) return;
    const currentNetworkPaymentSources =
      network === 'Mainnet' ? mainnetPaymentSources : preprodPaymentSources;
    const legacyOnlyPaymentSources = hasLegacyOnlyPaymentSources(currentNetworkPaymentSources);
    // Pages accessible even without payment sources (shown in setup sidebar).
    // Only consulted on the admin branch below — non-admins never enter setup mode.
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

    if (
      apiKey &&
      isHealthy &&
      activeRail !== 'x402' &&
      shouldRestoreX402Rail(
        router.pathname,
        x402Loading,
        x402ChainCount,
        isRouteChanging.current,
        suppressRailRestoreOnPathRef.current === router.pathname,
      )
    ) {
      setActiveRail('x402');
      return;
    }

    if (
      apiKey &&
      isHealthy &&
      capabilities.canAdmin &&
      currentNetworkPaymentSources.length === 0 &&
      !x402MaybeStandalone
    ) {
      const protectedPages = ['/', '/ai-agents', '/inbox-agents', '/wallets', '/transactions'];
      if (protectedPages.includes(router.pathname)) {
        router.replace('/setup?network=' + (network === 'Mainnet' ? 'Mainnet' : 'Preprod'));
      }
    }
    // Legacy-only operators should keep using the full admin UI with their V1
    // source visible. Setup mode is only for the /setup wizard, not a persisted
    // trap that hides the dashboard behind the V2 setup rail.
    if (
      apiKey &&
      isHealthy &&
      isSetupMode &&
      legacyOnlyPaymentSources &&
      !isSetupPath(router.pathname)
    ) {
      setIsSetupMode(false);
    }
    // If setup mode is active (persisted from before reload), redirect back to setup
    // but allow access to pages shown in the setup sidebar. Non-admins never enter setup.
    if (apiKey && isHealthy && isSetupMode && !capabilities.canAdmin) {
      setIsSetupMode(false);
    } else if (
      apiKey &&
      isHealthy &&
      isSetupMode &&
      capabilities.canAdmin &&
      !legacyOnlyPaymentSources &&
      router.pathname !== '/setup' &&
      !setupAccessiblePages.includes(router.pathname)
    ) {
      router.replace(
        setupPath(activeRail, router.pathname) +
          '?network=' +
          (network === 'Mainnet' ? 'Mainnet' : 'Preprod'),
      );
    }
    // Full context switch: on the x402 (EVM) rail, Cardano-only pages aren't in the
    // sidebar, so bounce direct/deep-link navigations to them back to the x402 hub.
    // Guard on confirmed x402 availability so a stale persisted rail (e.g. after the
    // env's chains were removed) can't trap the user away from Cardano pages — the
    // sidebar selector downgrades the rail to Cardano in that case.
    if (apiKey && isHealthy && !isSetupMode && x402Confirmed) {
      const cardanoOnlyPages = ['/', '/inbox-agents', '/wallets', '/transactions', '/invoices'];
      if (cardanoOnlyPages.includes(router.pathname)) {
        router.replace(X402_DASHBOARD_PATH);
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
    setIsSetupMode,
    activeRail,
    setActiveRail,
    x402Loading,
    x402Networks,
    capabilities.canAdmin,
    capabilities.canPay,
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

      const storedEncryptedKey = localStorage.getItem('payment_api_key');
      if (!storedEncryptedKey) {
        setIsHealthy(true);
        setAuthorized(false);
        return;
      }

      const storedApiKey = await decryptFromStorage(storedEncryptedKey);
      if (!storedApiKey) {
        localStorage.removeItem('payment_api_key');
        setIsHealthy(true);
        setAuthorized(false);
        return;
      }
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
      if (cancelled || localStorage.getItem('payment_api_key') !== storedEncryptedKey) return;

      if (!apiKeyStatus) {
        setIsHealthy(true);
        setAuthorized(false);
        return;
      }

      const nextCapabilities = capabilitiesFromApiKeyStatus(apiKeyStatus.data?.data);
      if (!nextCapabilities) {
        setIsHealthy(true);
        toast.error('Unauthorized access');
        signOut();
        return;
      }
      setCapabilities(nextCapabilities);
      setAuthorized(true);
      updateApiKey(storedApiKey);
      setIsHealthy(true);
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [apiClient, signOut, setAuthorized, setCapabilities, updateApiKey]);

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
            Your API key is invalid or lacks read access. Please sign out and sign in with a valid
            API key.
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

  // Do not mount admin-only pages for non-admins — a useEffect redirect alone
  // still lets the page run one paint of admin queries first.
  const blockAdminDeepLink =
    !!apiKey && authorized && !capabilities.canAdmin && isAdminOnlyPath(router.pathname);
  // x402 and webhook APIs are pay-authenticated; read-only keys have nothing useful there.
  const blockPayOnlyDeepLink =
    !!apiKey &&
    authorized &&
    !capabilities.canAdmin &&
    !capabilities.canPay &&
    isPayOnlyPath(router.pathname);

  if (blockAdminDeepLink || blockPayOnlyDeepLink) {
    return (
      <>
        <RouteProgressBar />
        <div className="flex items-center justify-center bg-background text-foreground fixed top-0 left-0 w-full h-full z-50">
          <Spinner size={20} addContainer />
        </div>
        {mounted && <ToastWrapper />}
      </>
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
              href={MASUMI_DOCUMENTATION_URL}
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
