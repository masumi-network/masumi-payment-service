import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { X402SetupWelcome } from '@/components/x402/setup/X402SetupWelcome';
import { AnimatedPage } from '@/components/ui/animated-page';
import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';

export default function X402SetupPage() {
  const { apiKey, network } = useAppContext();
  const router = useRouter();

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
