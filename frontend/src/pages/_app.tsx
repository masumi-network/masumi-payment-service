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
import { ThemeProvider } from '@/lib/contexts/ThemeContext';
import { SidebarProvider } from '@/lib/contexts/SidebarContext';
import { QueryProvider } from '@/lib/contexts/QueryProvider';
import { Spinner } from '@/components/ui/spinner';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { handleApiCall, normalizePathname } from '@/lib/utils';
import { useDynamicFavicon } from '@/hooks/useDynamicFavicon';
import { TooltipProvider } from '@/components/ui/tooltip';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';

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

function ThemedApp({ Component, pageProps, router }: AppProps) {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const [isMobile, setIsMobile] = useState(false);
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
  } = useAppContext();

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

  const { mainnetPaymentSources, preprodPaymentSources, isLoading } = usePaymentSourceExtendedAll();

  // Wait for router.isReady so pathname is correct (basePath + static export can be stale on first run).
  useEffect(() => {
    if (!router.isReady || isLoading) return;
    const currentNetworkPaymentSources =
      network === 'Mainnet' ? mainnetPaymentSources : preprodPaymentSources;
    const normalizedPathname = normalizePathname(router);
    if (apiKey && isHealthy && currentNetworkPaymentSources.length === 0) {
      const protectedPages = ['/', '/ai-agents', '/wallets', '/transactions', '/api-keys'];
      if (protectedPages.includes(normalizedPathname)) {
        router.replace('/setup?network=' + (network === 'Mainnet' ? 'Mainnet' : 'Preprod'));
      }
    } else if (apiKey && isHealthy && currentNetworkPaymentSources.length > 0) {
      if (normalizedPathname === '/setup') {
        router.replace('/');
      }
    }
    // router.replace is a stable function in Next.js, so it's safe to omit from dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    router.isReady,
    router.asPath,
    router.pathname,
    apiKey,
    isHealthy,
    isLoading,
    network,
    mainnetPaymentSources,
    preprodPaymentSources,
  ]);

  useEffect(() => {
    const init = async () => {
      const response = await handleApiCall(() => getHealth({ client: apiClient }), {
        onError: (error: any) => {
          console.error('Health check failed:', error);
          setIsHealthy(false);
        },
        errorMessage: 'Health check failed',
      });

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
          setIsHealthy(true);
          setAuthorized(false);
        },
        errorMessage: 'API key validation failed',
      });

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
  }, [apiClient, signOut, setAuthorized, updateApiKey]);

  // Watch for network changes in URL and update state
  useEffect(() => {
    const networkParam = router.query.network as string;

    if (networkParam && networkParam !== network) {
      if (networkParam.toLowerCase() === 'mainnet') {
        setNetwork('Mainnet');
      } else if (networkParam.toLowerCase() === 'preprod') {
        setNetwork('Preprod');
      }
    }
  }, [router.query.network, network, setNetwork]);

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

  if (isMobile) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex-1 flex items-center justify-center bg-background text-foreground">
          <div className="text-center space-y-4 p-4">
            <div className="text-lg text-muted-foreground">
              Please use a desktop device to <br /> access the Masumi Admin Interface
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
      {apiKey ? <Component {...pageProps} /> : <ApiKeyDialog />}
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
