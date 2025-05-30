import { SetupWelcome } from '@/components/setup/SetupWelcome';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

export default function SetupPage() {
  const { state } = useAppContext();
  const router = useRouter();
  const { network = 'preprod' } = router.query;

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
            ? network === 'preprod'
              ? 'Preprod Setup'
              : 'Mainnet Setup'
            : 'Setup'}{' '}
          | Admin Interface
        </title>
      </Head>
      <SetupWelcome networkType={network as string} />
    </>
  );
}
