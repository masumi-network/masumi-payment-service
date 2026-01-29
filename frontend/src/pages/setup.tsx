import { SetupWelcome } from '@/components/setup/SetupWelcome';
import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useRef, useCallback } from 'react';

export default function SetupPage() {
  const { apiKey, network, setNetwork, setIsSetupMode } = useAppContext();
  const router = useRouter();
  const initialSyncDone = useRef(false);

  // Sync URL network param to AppContext on initial mount
  useEffect(() => {
    if (initialSyncDone.current) return;
    if (!router.isReady) return;
    if (!apiKey) return;

    initialSyncDone.current = true;

    const urlNetwork = router.query.network;
    if (typeof urlNetwork === 'string') {
      const normalized = urlNetwork.toLowerCase() === 'mainnet' ? 'Mainnet' : 'Preprod';
      if (normalized !== network) {
        setNetwork(normalized);
      }
    }
    // Set setup mode AFTER network sync (setNetwork resets isSetupMode)
    setIsSetupMode(true);
  }, [router.isReady, router.query.network, setNetwork, apiKey, network, setIsSetupMode]);

  // Manage setup mode lifecycle
  useEffect(() => {
    if (!apiKey) return;

    setIsSetupMode(true);

    // Cleanup: reset setup mode when leaving the page
    return () => {
      setIsSetupMode(false);
    };
  }, [apiKey, setIsSetupMode]);

  // Handle network change from WelcomeScreen dropdown
  const handleNetworkChange = useCallback(
    (newNetwork: 'Preprod' | 'Mainnet') => {
      setNetwork(newNetwork);
      // Re-set setup mode after setNetwork (which resets it)
      setIsSetupMode(true);
      // Update URL for bookmarking/sharing
      router.replace(`/setup?network=${newNetwork}`, undefined, { shallow: true });
    },
    [setNetwork, setIsSetupMode, router],
  );

  useEffect(() => {
    if (!apiKey) {
      router.push('/');
    }
  }, [apiKey, router]);

  if (!apiKey) {
    return null;
  }

  return (
    <>
      <Head>
        <title>{network} Setup | Admin Interface</title>
      </Head>
      <MainLayout>
        <SetupWelcome networkType={network} onNetworkChange={handleNetworkChange} />
      </MainLayout>
    </>
  );
}
