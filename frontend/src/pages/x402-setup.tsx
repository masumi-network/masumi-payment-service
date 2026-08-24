import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { X402SetupWelcome } from '@/components/x402/setup/X402SetupWelcome';
import { AnimatedPage } from '@/components/ui/animated-page';
import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';

export default function X402SetupPage() {
  const { apiKey, network, setNetwork, setActiveRail, setIsSetupMode, setSetupWizardStep } =
    useAppContext();
  const router = useRouter();

  useEffect(() => {
    setActiveRail('x402');
    setIsSetupMode(true);
    return () => {
      setIsSetupMode(false);
      setSetupWizardStep(0);
    };
  }, [setActiveRail, setIsSetupMode, setSetupWizardStep]);

  useEffect(() => {
    if (!router.isReady) return;
    const requestedNetwork = router.query.network;
    if (
      typeof requestedNetwork === 'string' &&
      (requestedNetwork === 'Preprod' || requestedNetwork === 'Mainnet') &&
      requestedNetwork !== network
    ) {
      setNetwork(requestedNetwork);
    }
  }, [network, router.isReady, router.query.network, setNetwork]);

  useEffect(() => {
    if (!apiKey) {
      router.replace('/');
    }
  }, [apiKey, router]);

  if (!apiKey) {
    return null;
  }

  return (
    <>
      <Head>
        <title>{network} x402 Setup | Admin Interface</title>
      </Head>
      <MainLayout>
        <AnimatedPage>
          <X402SetupWelcome networkType={network} />
        </AnimatedPage>
      </MainLayout>
    </>
  );
}
