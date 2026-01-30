import { SetupWelcome } from '@/components/setup/SetupWelcome';
import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

export default function SetupPage() {
  const { apiKey, network, setIsSetupMode } = useAppContext();
  const router = useRouter();

  useEffect(() => {
    setIsSetupMode(true);
    return () => {
      // Cleanup: Reset setup mode when leaving the setup page
      setIsSetupMode(false);
    };
  }, [setIsSetupMode]);

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
        <SetupWelcome networkType={network} />
      </MainLayout>
    </>
  );
}
