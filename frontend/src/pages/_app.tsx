import { AppProvider, initialAppState } from "@/lib/contexts/AppContext";
import { useEffect, useState } from "react";
import "@/styles/globals.css";
import "@/styles/styles.scss"
import type { AppProps } from "next/app";
import { useAppContext } from "@/lib/contexts/AppContext";
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

function InitializeApp() {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const { dispatch } = useAppContext();
  
  useEffect(() => {
    const init = async () => {
      try {
        const response = await fetch('/api/health');
        const health = response.ok;
        
        if (!response.ok) {
          console.error('Health check failed:', await response.text());
        }
        
        setIsHealthy(health);

        if (health) {
          try {
            const sourceResponse = await fetch('/api/payment-source');
            if (!sourceResponse.ok) {
              throw new Error('Failed to fetch payment sources');
            }
            
            const sourceData = await sourceResponse.json();
            const sources = sourceData?.data?.paymentSources || [];
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
        }
      } catch (error) {
        console.error('Health check failed:', error);
        setIsHealthy(false);
      }
    };

    init();
  }, [dispatch]);

  // Loading and error states
  if (isHealthy === null) {
    return <div className="flex h-screen items-center justify-center bg-[#000] fixed top-0 left-0 w-full h-full z-50">
      <div className="text-center space-y-4">
        <div className="text-lg">Checking system status...</div>
        <div className="text-sm text-muted-foreground">Please wait...</div>
      </div>
    </div>;
  }

  if (isHealthy === false) {
    return <div className="flex h-screen items-center justify-center bg-[#000] fixed top-0 left-0 w-full h-full z-50">
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

function AppContent({ Component, pageProps }: AppProps) {
  return (
    <AppProvider initialState={initialAppState}>
      <InitializeApp />
      {<div className="dark">
        <Component {...pageProps} />
      </div>}
    </AppProvider>
  );
}

export default AppContent;
