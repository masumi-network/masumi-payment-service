import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
} from 'react';
import { ErrorDialog } from '@/components/ui/error-dialog';
import { Client, createClient } from '@/lib/api/generated/client';
import { usePaymentSourceExtendedAllWithParams } from '../hooks/usePaymentSourceExtendedAll';
import { PaymentSource } from '../api/generated';

type NetworkType = 'Preprod' | 'Mainnet';

export const AppContext = createContext<
  | {
      selectedPaymentSource: PaymentSource | null;
      apiKey: string | null;
      updateApiKey: (apiKey: string | null) => void;
      authorized: boolean;
      setAuthorized: (authorized: boolean) => void;
      network: NetworkType;
      setNetwork: (network: NetworkType) => void;
      showError: (error: { code?: number; message: string; details?: unknown }) => void;
      apiClient: Client;
      setApiClient: React.Dispatch<React.SetStateAction<Client>>;
      selectedPaymentSourceId: string | null;
      setSelectedPaymentSourceId: (id: string | null) => void;
      signOut: () => void;
      isChangingNetwork: boolean;
    }
  | undefined
>(undefined);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [error, setError] = useState<{
    code?: number;
    message: string;
    details?: unknown;
  } | null>(null);
  const [apiClient, setApiClient] = useState(
    createClient({
      baseURL: process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL,
    }),
  );

  const [authorized, setAuthorized] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [network, setNetwork] = useState<NetworkType>('Preprod');

  const { paymentSources } = usePaymentSourceExtendedAllWithParams({
    apiClient,
    apiKey,
  });

  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((ps) => ps.network === network),
    [paymentSources, network],
  );

  const [selectedPaymentSourceId, setSelectedPaymentSourceId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('selectedPaymentSourceId');
      return stored || null;
    }
    return null;
  });

  const [selectedPaymentSource, setSelectedPaymentSource] = useState<PaymentSource | null>(null);

  const [isChangingNetwork, setIsChangingNetwork] = useState(false);
  const previousNetworkRef = useRef<NetworkType>(network);

  // Persist selectedPaymentSourceId to localStorage whenever it changes
  const setSelectedPaymentSourceIdAndPersist = (id: string | null) => {
    setSelectedPaymentSourceId(id);
    if (typeof window !== 'undefined') {
      if (id) {
        localStorage.setItem('selectedPaymentSourceId', id);
      } else {
        localStorage.removeItem('selectedPaymentSourceId');
      }
    }
  };

  useEffect(() => {
    let isCurrent = true;

    queueMicrotask(() => {
      if (!isCurrent) return;

      if (!selectedPaymentSourceId && currentNetworkPaymentSources.length > 0) {
        setSelectedPaymentSourceIdAndPersist(currentNetworkPaymentSources[0].id);
      }
      if (selectedPaymentSourceId && currentNetworkPaymentSources.length > 0) {
        const foundPaymentSource = currentNetworkPaymentSources.find(
          (ps) => ps.id === selectedPaymentSourceId,
        );

        if (foundPaymentSource) {
          if (foundPaymentSource.network !== network) {
            setSelectedPaymentSourceIdAndPersist(null);
          } else {
            setSelectedPaymentSource(foundPaymentSource);
          }
        } else {
          setSelectedPaymentSourceIdAndPersist(null);
          setSelectedPaymentSource(null);
        }
      }
    });

    return () => {
      isCurrent = false;
    };
  }, [selectedPaymentSourceId, currentNetworkPaymentSources, network]);

  useEffect(() => {
    if (previousNetworkRef.current !== network) {
      queueMicrotask(() => setIsChangingNetwork(true));
      setTimeout(() => {
        setIsChangingNetwork(false);
      }, 500);
      previousNetworkRef.current = network;
    }
  }, [network]);

  const showError = useCallback((error: { code?: number; message: string; details?: unknown }) => {
    setError(error);
  }, []);

  const signOut = useCallback(() => {
    setApiKey(null);
    setAuthorized(false);
    setNetwork('Preprod');
    setSelectedPaymentSourceId(null);
    setSelectedPaymentSource(null);
    setIsChangingNetwork(false);
    setError(null);

    // Clear all localStorage items
    localStorage.removeItem('payment_api_key');
    localStorage.removeItem('selectedPaymentSourceId');
    localStorage.removeItem('userIgnoredSetup');
    localStorage.removeItem('masumi_last_transactions_visit');
    localStorage.removeItem('masumi_new_transactions_count');
  }, []);

  return (
    <AppContext.Provider
      value={{
        selectedPaymentSource,
        apiKey,
        updateApiKey: (newApiKey: string | null) => {
          if (newApiKey === apiKey) {
            return;
          }
          setApiKey(newApiKey);
          if (newApiKey) {
            setApiClient(
              createClient({
                headers: { token: newApiKey },
                baseURL: process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL,
              }),
            );
            setAuthorized(true);
          } else {
            setAuthorized(false);
            setApiClient(
              createClient({
                headers: { token: 'invalid-api' },
                baseURL: process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL,
              }),
            );
          }
        },
        setAuthorized,
        authorized,
        network,
        setNetwork: (network: NetworkType) => {
          setNetwork(network);
          setSelectedPaymentSourceIdAndPersist(null);
        },
        showError,
        apiClient,
        setApiClient,
        selectedPaymentSourceId,
        setSelectedPaymentSourceId: setSelectedPaymentSourceIdAndPersist,
        signOut,
        isChangingNetwork,
      }}
    >
      {children}
      <ErrorDialog open={!!error} onClose={() => setError(null)} error={error || { message: '' }} />
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('Put it in AppProvider');
  }
  return context;
}
