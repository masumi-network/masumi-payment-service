/* eslint-disable @typescript-eslint/no-explicit-any */
import { AppProvider, initialAppState } from "@/lib/contexts/AppContext";
import { useEffect, useState, useCallback } from "react";
import "@/styles/globals.css";
import "@/styles/styles.scss"
import type { AppProps } from "next/app";
import { useAppContext } from "@/lib/contexts/AppContext";
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { useRouter } from 'next/router';
import { ApiKeyDialog } from "@/components/ApiKeyDialog";
import { getPaymentSources } from "@/lib/query/api/payment-source";
import { checkHealth } from "@/lib/query/api/health";

function InitializeApp() {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const { state, dispatch } = useAppContext();
  const router = useRouter();

  const fetchPaymentSources = useCallback(async () => {
    try {
      const sourceResponse = await getPaymentSources(state.apiKey!);
      const { data } = sourceResponse;

      const sources = data?.paymentSources || [];
      const sortedByCreatedAt = sources.sort((a: any, b: any) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      const reversed = [...sortedByCreatedAt]?.reverse();
      const sourcesMapped = reversed?.map((source: any, index: number) => ({
        ...source,
        index: index + 1
      }));
      const reversedBack = [...sourcesMapped]?.reverse();

      dispatch({ type: 'SET_PAYMENT_SOURCES', payload: reversedBack });
    } catch (error) {
      console.error('Failed to fetch payment sources:', error);
      toast.error('Error fetching payment sources. Please try again later.');
    }
  }, [state.apiKey, dispatch]);

  useEffect(() => {
    const init = async () => {
      try {
        await checkHealth();

        const hexedKey = localStorage.getItem("payment_api_key");
        if (!hexedKey) {
          setIsHealthy(true);
          return;
        }

        const storedApiKey = Buffer.from(hexedKey, 'hex').toString('utf-8');
        dispatch({ type: 'SET_API_KEY', payload: storedApiKey });
        setIsHealthy(true);

      } catch (error) {
        console.error('Health check failed:', error);
        setIsHealthy(false);
      }
    };

    init();
  }, [dispatch]);

  useEffect(() => {
    if (isHealthy && router.pathname === '/') {
      fetchPaymentSources();
    }
  }, [router.pathname, isHealthy, fetchPaymentSources]);

  if (isHealthy === null) {
    return <div className="flex items-center justify-center bg-[#000] fixed top-0 left-0 w-full h-full z-50">
      <div className="text-center space-y-4">
        <div className="text-lg">Checking system status...</div>
        <div className="text-sm text-muted-foreground">Please wait...</div>
      </div>
    </div>;
  }

  if (isHealthy === false) {
    return <div className="flex items-center justify-center bg-[#000] fixed top-0 left-0 w-full h-full z-50">
      <div className="text-center space-y-4">
        <div className="text-lg text-destructive">System Unavailable</div>
        <div className="text-sm text-muted-foreground">
          Unable to connect to required services. Please try again later.
        </div>
      </div>
    </div>;
  }

  return null;
}

function ComponentHolder({ Component, pageProps, }: AppProps) {
  const { state } = useAppContext();
  return <div className="dark">
    {state.apiKey ? <Component {...pageProps} /> : <ApiKeyDialog />}
  </div>;
}

function AppContent({ Component, pageProps, router }: AppProps) {
  return (
    <AppProvider initialState={initialAppState}>
      <InitializeApp />
      <ComponentHolder Component={Component} pageProps={pageProps} router={router} />
    </AppProvider>
  );
}

export default AppContent;
