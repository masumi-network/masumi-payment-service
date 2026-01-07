import { SetupWelcome } from '@/components/setup/SetupWelcome';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

export default function SetupPage() {
  const { apiKey } = useAppContext();
  const router = useRouter();
  const { network = 'Preprod' } = router.query;
  let networkType = 'Preprod';
  if (typeof network === 'string') {
    networkType = network.toLowerCase();
  }
  if (typeof networkType !== 'string') {
    networkType = 'Preprod';
  }

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
        <title>
          {network
            ? networkType.toLocaleLowerCase() === 'mainnet'
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
