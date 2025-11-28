import { SetupWelcome } from '@/components/setup/SetupWelcome';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

export default function SetupPage() {
  const { state } = useAppContext();
  const router = useRouter();
  const { network = 'Preprod' } = router.query;

  useEffect(() => {
    if (!state.apiKey) {
      router.push('/');
    }
  }, [state.apiKey, router]);

  if (!state.apiKey) {
    return null;
  }

  return (
    <>
      <Head>
        <title>
          {network
            ? (network as string).toUpperCase() === 'MAINNET'
              ? 'Mainnet Setup'
              : 'Preprod Setup'
            : 'Setup'}{' '}
          | Admin Interface
        </title>
      </Head>
      <SetupWelcome networkType={network as string} />
    </>
  );
}
