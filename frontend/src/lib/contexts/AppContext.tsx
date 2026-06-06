import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorDialog } from '@/components/ui/error-dialog';
import { Client, createClient } from '@/lib/api/generated/client';
import { usePaymentSourceExtendedAllWithParams } from '../hooks/usePaymentSourceExtendedAll';
import type { PaymentSourceExtended } from '../api/generated';
import { getPreferredPaymentSource } from '@/lib/payment-source-type';

export type NetworkType = 'Preprod' | 'Mainnet';

// Which payment rail the UI is currently in context of. 'cardano' is the
// historical default; 'x402' surfaces the EVM rail (chains/wallets/budgets).
export type ActiveRail = 'cardano' | 'x402';

export const AppContext = createContext<
  | {
      selectedPaymentSource: PaymentSourceExtended | null;
      activeRail: ActiveRail;
      setActiveRail: (rail: ActiveRail) => void;
      selectedX402ChainId: string | null;
      setSelectedX402ChainId: (id: string | null) => void;
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
      isSetupMode: boolean;
      setIsSetupMode: (isSetupMode: boolean) => void;
      setupWizardStep: number;
      setSetupWizardStep: (step: number) => void;
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
  const [network, setNetworkState] = useState<NetworkType>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('masumi_network');
      if (stored === 'Mainnet' || stored === 'Preprod') return stored;
    }
    return 'Preprod';
  });
  const setNetwork = useCallback((value: NetworkType) => {
    setNetworkState(value);
    if (typeof window !== 'undefined') {
      localStorage.setItem('masumi_network', value);
    }
  }, []);
  const [isSetupMode, setIsSetupModeState] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('masumi_setup_mode') === 'true';
    }
    return false;
  });
  const setIsSetupMode = useCallback((value: boolean) => {
    setIsSetupModeState(value);
    if (typeof window !== 'undefined') {
      if (value) {
        localStorage.setItem('masumi_setup_mode', 'true');
      } else {
        localStorage.removeItem('masumi_setup_mode');
      }
    }
  }, []);
  const [setupWizardStep, setSetupWizardStep] = useState(0);

  const [activeRail, setActiveRailState] = useState<ActiveRail>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('masumi_active_rail');
      if (stored === 'cardano' || stored === 'x402') return stored;
    }
    return 'cardano';
  });
  const setActiveRail = useCallback((value: ActiveRail) => {
    setActiveRailState(value);
    if (typeof window !== 'undefined') {
      localStorage.setItem('masumi_active_rail', value);
    }
  }, []);

  const [selectedX402ChainId, setSelectedX402ChainIdState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('masumi_x402_chain_id') || null;
    }
    return null;
  });
  const setSelectedX402ChainId = useCallback((id: string | null) => {
    setSelectedX402ChainIdState(id);
    if (typeof window !== 'undefined') {
      if (id) {
        localStorage.setItem('masumi_x402_chain_id', id);
      } else {
        localStorage.removeItem('masumi_x402_chain_id');
      }
    }
  }, []);

  const queryClient = useQueryClient();

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

  const [selectedPaymentSource, setSelectedPaymentSource] = useState<PaymentSourceExtended | null>(
    null,
  );

  const [isChangingNetwork, setIsChangingNetwork] = useState(false);
  const previousNetworkRef = useRef<NetworkType>(network);

  // Persist selectedPaymentSourceId to localStorage whenever it changes
  const setSelectedPaymentSourceIdAndPersist = useCallback((id: string | null) => {
    setSelectedPaymentSourceId(id);
    if (typeof window !== 'undefined') {
      if (id) {
        localStorage.setItem('selectedPaymentSourceId', id);
      } else {
        localStorage.removeItem('selectedPaymentSourceId');
      }
    }
  }, []);

  // Memoized network setter to prevent infinite re-render loops
  // (unstable reference caused URL sync effect in _app.tsx to re-run every render)
  const setNetworkWithReset = useCallback(
    (newNetwork: NetworkType) => {
      setNetwork(newNetwork);
      setSelectedPaymentSourceIdAndPersist(null);
      // The env toggle also re-groups EVM chains (testnet<->Preprod, mainnet<->Mainnet),
      // so the previously selected chain may no longer belong to the new env.
      setSelectedX402ChainId(null);
    },
    [setNetwork, setSelectedPaymentSourceIdAndPersist, setSelectedX402ChainId],
  );

  useEffect(() => {
    if (currentNetworkPaymentSources.length === 0) {
      if (selectedPaymentSourceId) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronizing localStorage-backed selection with available payment sources requires state updates
        setSelectedPaymentSourceIdAndPersist(null);
      }
      setSelectedPaymentSource(null);
      return;
    }

    const foundPaymentSource = selectedPaymentSourceId
      ? currentNetworkPaymentSources.find((ps) => ps.id === selectedPaymentSourceId)
      : null;
    const nextPaymentSource =
      foundPaymentSource ?? getPreferredPaymentSource(currentNetworkPaymentSources);

    if (!nextPaymentSource) {
      setSelectedPaymentSource(null);
      return;
    }

    if (selectedPaymentSourceId !== nextPaymentSource.id) {
      setSelectedPaymentSourceIdAndPersist(nextPaymentSource.id);
    }
    setSelectedPaymentSource(nextPaymentSource);
  }, [
    selectedPaymentSourceId,
    currentNetworkPaymentSources,
    network,
    setSelectedPaymentSourceIdAndPersist,
  ]);

  useEffect(() => {
    if (previousNetworkRef.current !== network) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Network change animation state must be set synchronously to coordinate with setTimeout cleanup
      setIsChangingNetwork(true);
      setTimeout(() => {
        setIsChangingNetwork(false);
      }, 500);
      previousNetworkRef.current = network;
    }
  }, [network]);

  // Invalidate payment-source-scoped queries whenever the active source changes.
  // Query keys for transactions/wallets/etc. include the source id; without invalidation
  // the UI can briefly render stale rows from the previous source.
  // Skip the initial render (and the null->null transition before sources hydrate)
  // so we don't mass-invalidate on every login / page-load when nothing has actually
  // changed. Only fire when transitioning from a previous non-null source to a
  // different one.
  const previousSelectedPaymentSourceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      previousSelectedPaymentSourceIdRef.current !== null &&
      previousSelectedPaymentSourceIdRef.current !== selectedPaymentSourceId
    ) {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
      queryClient.invalidateQueries({ queryKey: ['payment-source-extended'] });
    }
    previousSelectedPaymentSourceIdRef.current = selectedPaymentSourceId;
  }, [selectedPaymentSourceId, queryClient]);

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
    setIsSetupMode(false);
    setSetupWizardStep(0);
    setActiveRail('cardano');
    setSelectedX402ChainId(null);
    setError(null);

    // Clear all localStorage items
    localStorage.removeItem('payment_api_key');
    localStorage.removeItem('selectedPaymentSourceId');
    localStorage.removeItem('masumi_active_rail');
    localStorage.removeItem('masumi_x402_chain_id');
    localStorage.removeItem('masumi_x402_banner_dismissed_Preprod');
    localStorage.removeItem('masumi_x402_banner_dismissed_Mainnet');
    localStorage.removeItem('userIgnoredSetup');
    localStorage.removeItem('masumi_last_transactions_visit');
    localStorage.removeItem('masumi_new_transactions_count');
    localStorage.removeItem('masumi_network');
    localStorage.removeItem('masumi_acknowledged_wallet_alerts');
  }, [setIsSetupMode, setNetwork, setActiveRail, setSelectedX402ChainId]);

  return (
    <AppContext.Provider
      value={{
        selectedPaymentSource,
        activeRail,
        setActiveRail,
        selectedX402ChainId,
        setSelectedX402ChainId,
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
          // Drop all cached query results so subsequent fetches use the new client/credentials.
          queryClient.removeQueries();
        },
        setAuthorized,
        authorized,
        network,
        setNetwork: setNetworkWithReset,
        showError,
        apiClient,
        setApiClient,
        selectedPaymentSourceId,
        setSelectedPaymentSourceId: setSelectedPaymentSourceIdAndPersist,
        signOut,
        isChangingNetwork,
        isSetupMode,
        setIsSetupMode,
        setupWizardStep,
        setSetupWizardStep,
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
