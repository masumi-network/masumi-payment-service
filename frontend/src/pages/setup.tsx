import { SetupWelcomeContent } from '@/components/setup/SetupWelcome';
import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';

export default function SetupPage() {
  const { apiKey, network, setNetwork } = useAppContext();
  const router = useRouter();
  const urlNetwork = router.query.network;

  const initialSyncDone = useRef(false);

  // Sync URL network param to AppContext only once on initial mount (only if explicitly provided)
  useEffect(() => {
    if (initialSyncDone.current) return;
    if (!router.isReady) return;

    initialSyncDone.current = true;

    // Only sync if an explicit network parameter was provided in the URL
    if (typeof urlNetwork === 'string') {
      const normalized =
        urlNetwork.toLowerCase() === 'mainnet' ? 'Mainnet' : 'Preprod';
      setNetwork(normalized);
    }
  }, [router.isReady, urlNetwork, setNetwork]);

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
        <SetupWelcomeContent />
      </MainLayout>
    </>
  );
}
