/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */
import { AppProvider, initialAppState } from '@/lib/contexts/AppContext';
import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import '@/styles/globals.css';
import '@/styles/styles.scss';
import type { AppProps } from 'next/app';
import { useAppContext } from '@/lib/contexts/AppContext';
import { toast, ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { ApiKeyDialog } from '@/components/api-keys/ApiKeyDialog';
import {
  getHealth,
  getPaymentSource,
  getApiKeyStatus,
} from '@/lib/api/generated';
import { ThemeProvider } from '@/lib/contexts/ThemeContext';
import { SidebarProvider } from '@/lib/contexts/SidebarContext';
import { Spinner } from '@/components/ui/spinner';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { handleApiCall } from '@/lib/utils';
import { useDynamicFavicon } from '@/hooks/useDynamicFavicon';
import { TooltipProvider } from '@/components/ui/tooltip';

function App({ Component, pageProps, router }: AppProps) {
  return (
    <ThemeProvider>
      <AppProvider initialState={initialAppState}>
        <SidebarProvider>
          <TooltipProvider delayDuration={200}>
            <ThemedApp
              Component={Component}
              pageProps={pageProps}
              router={router}
            />
          </TooltipProvider>
        </SidebarProvider>
      </AppProvider>
    </ThemeProvider>
  );
}

function ThemedApp({ Component, pageProps, router }: AppProps) {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { state, dispatch, setSelectedPaymentSourceId, apiClient, signOut } =
    useAppContext();

  // Add dynamic favicon functionality
  useDynamicFavicon();

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 1024);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const fetchPaymentSources = useCallback(async () => {
    const sourceResponse = await getPaymentSource({
      client: apiClient,
    });

    if (sourceResponse.error) {
      const error = sourceResponse.error as { message: string };
      console.error('Failed to fetch payment sources:', error);
      toast.error(
        error.message ||
          'Error fetching payment sources. Please try again later.',
      );
      return;
    }

    const { data } = sourceResponse;

    const sources = data?.data?.PaymentSources ?? [];
    // Filter by network
    const filteredSources = sources.filter(
      (source: any) => source.network === state.network,
    );
    // Sort by createdAt descending (newest first) and add index
    const sortedSources = filteredSources
      .sort(
        (a: any, b: any) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .map((source: any, index: number) => ({
        ...source,
        index: index + 1,
      }));

    dispatch({ type: 'SET_PAYMENT_SOURCES', payload: sortedSources });

    if (sortedSources.length === 1) {
      setSelectedPaymentSourceId(sortedSources[0].id);
    }

    // If no payment sources, redirect to setup
    if (sortedSources.length === 0 && isHealthy && state.apiKey) {
      if (router.pathname !== '/setup') {
        router.push(`/setup?network=${encodeURIComponent(state.network)}`);
      }
    }

    if (state.apiKey && isHealthy && filteredSources.length === 0) {
      const protectedPages = [
        '/',
        '/ai-agents',
        '/wallets',
        '/transactions',
        '/api-keys',
      ];
      if (protectedPages.includes(router.pathname)) {
        router.replace('/payment-sources');
      }
    } else if (state.apiKey && isHealthy && filteredSources.length > 0) {
      if (router.pathname === '/setup') {
        router.replace('/');
      }
    }
  }, [
    apiClient,
    dispatch,
    isHealthy,
    state.apiKey,
    state.network,
    router.pathname,
  ]); // setSelectedPaymentSourceId is stable, excluding to prevent infinite loop

  useEffect(() => {
    const init = async () => {
      dispatch({ type: 'SET_UNAUTHORIZED', payload: false });
      const response = await handleApiCall(
        () => getHealth({ client: apiClient }),
        {
          onError: (error: any) => {
            console.error('Health check failed:', error);
            setIsHealthy(false);
          },
          errorMessage: 'Health check failed',
        },
      );

      if (!response) return;

      const hexedKey = localStorage.getItem('payment_api_key');
      if (!hexedKey) {
        setIsHealthy(true);
        return;
      }

      const storedApiKey = Buffer.from(hexedKey, 'hex').toString('utf-8');
      apiClient.setConfig({
        headers: {
          token: storedApiKey,
        },
      });
      const apiKeyStatus = await handleApiCall(
        () => getApiKeyStatus({ client: apiClient }),
        {
          onError: (error: any) => {
            console.error('API key status check failed:', error);
            setIsHealthy(true);
            dispatch({ type: 'SET_UNAUTHORIZED', payload: true });
          },
          errorMessage: 'API key validation failed',
        },
      );

      if (!apiKeyStatus) {
        setIsHealthy(true);
        dispatch({ type: 'SET_UNAUTHORIZED', payload: true });
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
      dispatch({ type: 'SET_API_KEY', payload: storedApiKey });
      setIsHealthy(true);
    };

    init();
  }, [apiClient, dispatch, signOut]);

  useEffect(() => {
    if (isHealthy && state.apiKey) {
      fetchPaymentSources();
    }
  }, [isHealthy, state.apiKey, fetchPaymentSources, state.network]);

  // Watch for network changes in URL and update state
  useEffect(() => {
    const networkParam = router.query.network as string;

    if (networkParam && networkParam !== state.network) {
      dispatch({
        type: 'SET_NETWORK',
        payload: networkParam as 'Mainnet' | 'Preprod',
      });
    }
  }, [router.query.network, state.network, dispatch]);

  if (isHealthy === null) {
    return (
      <div className="flex items-center justify-center bg-background text-foreground fixed top-0 left-0 w-full h-full z-50">
        <div className="text-center space-y-4">
          <Spinner size={20} addContainer />
        </div>
      </div>
    );
  }

  if (state.isUnauthorized) {
    return (
      <div className="flex items-center justify-center bg-background text-foreground fixed top-0 left-0 w-full h-full z-50">
        <div className="text-center space-y-4">
          <div className="text-lg text-destructive">Unauthorized</div>
          <div className="text-sm text-muted-foreground">
            Your API key is invalid or does not have admin permissions. Please
            sign out and sign in with an admin API key.
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

  if (isMobile) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex-1 flex items-center justify-center bg-background text-foreground">
          <div className="text-center space-y-4 p-4">
            <div className="text-lg text-muted-foreground">
              Please use a desktop device to <br /> access the Masumi Admin
              Interface
            </div>
            <Button variant="muted">
              <Link href="https://docs.masumi.io" target="_blank">
                Learn more
              </Link>
            </Button>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <>
      {state.apiKey ? <Component {...pageProps} /> : <ApiKeyDialog />}
      {mounted &&
        createPortal(
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
            theme="dark"
          />,
          document.body,
        )}
    </>
  );
}

export default App;
