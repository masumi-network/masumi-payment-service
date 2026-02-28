import { SetupWelcome } from '@/components/setup/SetupWelcome';
import { AnimatedPage } from '@/components/ui/animated-page';
import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

export default function SetupPage() {
  const { apiKey, network, setIsSetupMode, setSetupWizardStep } = useAppContext();
  const router = useRouter();

  useEffect(() => {
    setIsSetupMode(true);
    return () => {
      setIsSetupMode(false);
      setSetupWizardStep(0);
    };
  }, [setIsSetupMode, setSetupWizardStep]);

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
        <AnimatedPage>
          <SetupWelcome networkType={network} />
        </AnimatedPage>
      </MainLayout>
    </>
  );
}
