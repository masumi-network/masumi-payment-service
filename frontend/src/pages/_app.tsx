/* eslint-disable @typescript-eslint/no-explicit-any */
import { AppProvider, initialAppState } from '@/lib/contexts/AppContext';
import { useEffect, useState, useCallback } from 'react';
import '@/styles/globals.css';
import '@/styles/styles.scss';
import type { AppProps } from 'next/app';
import { useAppContext } from '@/lib/contexts/AppContext';
import { toast, ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { ApiKeyDialog } from '@/components/ApiKeyDialog';
import {
  getHealth,
  getPaymentSource,
  getRpcApiKeys,
  getApiKeyStatus,
} from '@/lib/api/generated';
import { ThemeProvider } from '@/lib/contexts/ThemeContext';
import { Spinner } from '@/components/ui/spinner';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

function App({ Component, pageProps, router }: AppProps) {
  return (
    <ThemeProvider>
      <AppProvider initialState={initialAppState}>
        <ThemedApp
          Component={Component}
          pageProps={pageProps}
          router={router}
        />
      </AppProvider>
    </ThemeProvider>
  );
}

function ThemedApp({ Component, pageProps, router }: AppProps) {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const [isUnauthorized, setIsUnauthorized] = useState<boolean>(false);
  const [isMobile, setIsMobile] = useState(false);
  const { state, dispatch, setSelectedPaymentSourceId, apiClient } =
    useAppContext();

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 1024);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const fetchPaymentSources = useCallback(async () => {
    try {
      const sourceResponse = await getPaymentSource({
        client: apiClient,
      });
      const { data } = sourceResponse;

      const sources = data?.data?.PaymentSources ?? [];
      // Filter by network
      const filteredSources = sources.filter(
        (source: any) => source.network === state.network,
      );
      const sortedByCreatedAt = filteredSources.sort(
        (a: any, b: any) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      const reversed = [...sortedByCreatedAt]?.reverse();
      const sourcesMapped = reversed?.map((source: any, index: number) => ({
        ...source,
        index: index + 1,
      }));
      const reversedBack = [...sourcesMapped]?.reverse();

      dispatch({ type: 'SET_PAYMENT_SOURCES', payload: reversedBack });

      if (reversedBack.length === 1) {
        setSelectedPaymentSourceId(reversedBack[0].id);
      }

      // If no payment sources, redirect to setup
      if (reversedBack.length === 0 && isHealthy && state.apiKey) {
        if (router.pathname !== '/setup') {
          router.push(`/setup?network=${encodeURIComponent(state.network)}`);
        }
      }
    } catch (error) {
      console.error('Failed to fetch payment sources:', error);
      toast.error('Error fetching payment sources. Please try again later.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, dispatch, isHealthy, state.apiKey, state.network, router]); // setSelectedPaymentSourceId is stable, excluding to prevent infinite loop

  const fetchRpcApiKeys = useCallback(async () => {
    try {
      const response = await getRpcApiKeys({
        client: apiClient,
      });

      const rpcKeys = response.data?.RpcProviderKeys ?? [];
      dispatch({ type: 'SET_RPC_API_KEYS', payload: rpcKeys });
    } catch (error) {
      console.error('Failed to fetch RPC API keys:', error);
      toast.error('Error fetching RPC API keys. Please try again later.');
    }
  }, [apiClient, dispatch]);

  const signOut = useCallback(() => {
    // Clear all localStorage items
    localStorage.removeItem('payment_api_key');
    localStorage.removeItem('selectedPaymentSourceId');
    localStorage.removeItem('userIgnoredSetup');
    localStorage.removeItem('masumi_last_transactions_visit');
    localStorage.removeItem('masumi_new_transactions_count');
    localStorage.removeItem('dialogPosition');
    localStorage.removeItem('theme');

    // Reset all app state
    dispatch({ type: 'SET_API_KEY', payload: '' });
    dispatch({ type: 'SET_PAYMENT_SOURCES', payload: [] });
    dispatch({ type: 'SET_CONTRACTS', payload: [] });
    dispatch({ type: 'SET_WALLETS', payload: [] });
    dispatch({ type: 'SET_RPC_API_KEYS', payload: [] });

    // Reset component state
    setIsUnauthorized(false);
    setIsHealthy(null);

    // Force redirect to login page
    window.location.href = '/';
  }, [dispatch]);

  useEffect(() => {
    const init = async () => {
      try {
        setIsUnauthorized(false);
        const response = await getHealth({ client: apiClient });

        if (response.status !== 200) {
          setIsHealthy(false);
          return;
        }

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
        const apiKeyStatus = await getApiKeyStatus({ client: apiClient });
        if (apiKeyStatus.status !== 200) {
          setIsHealthy(true);
          setIsUnauthorized(true);
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
      } catch (error) {
        console.error('Health check failed:', error);
        setIsHealthy(false);
      }
    };

    init();
  }, [apiClient, dispatch, signOut]);

  useEffect(() => {
    if (isHealthy && state.apiKey) {
      fetchPaymentSources();
    }
  }, [isHealthy, state.apiKey, fetchPaymentSources, state.network]);

  useEffect(() => {
    if (isHealthy && state.apiKey) {
      fetchRpcApiKeys();
    }
  }, [isHealthy, state.apiKey, fetchRpcApiKeys]);

  if (isHealthy === null) {
    return (
      <div className="flex items-center justify-center bg-background text-foreground fixed top-0 left-0 w-full h-full z-50">
        <div className="text-center space-y-4">
          <Spinner size={20} addContainer />
        </div>
      </div>
    );
  }

  if (isUnauthorized) {
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
      />
    </>
  );
}

export default App;
