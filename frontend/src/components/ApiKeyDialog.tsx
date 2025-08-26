import { Button } from './ui/button';
import { Input } from './ui/input';
import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getApiKeyStatus, getPaymentSource } from '@/lib/api/generated';
import { Header } from './Header';
import { Footer } from './Footer';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';

interface ApiError {
  message: string;
  error?: {
    message?: string;
  };
}

export function ApiKeyDialog() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { dispatch, apiClient } = useAppContext();

  const handleApiKeySubmit = async (key: string) => {
    setError('');
    setIsLoading(true);

    try {
      apiClient.setConfig({ headers: { token: key } });

      const statusResponse = await getApiKeyStatus({
        client: apiClient,
      });

      if (statusResponse.data?.data.status !== 'Active') {
        throw new Error('Invalid Key: Admin key is not active');
      }

      // Check if the API key has admin permission
      const permission = statusResponse.data?.data?.permission;
      if (!permission || permission !== 'Admin') {
        throw new Error('Invalid Key: Admin permission required');
      }

      const hexKey = Buffer.from(key).toString('hex');
      localStorage.setItem('payment_api_key', hexKey);
      dispatch({ type: 'SET_API_KEY', payload: key });

      const sourcesResponse = await getPaymentSource({
        client: apiClient,
      });

      const sources = sourcesResponse.data?.data?.PaymentSources ?? [];

      if (sources.length === 0) {
        const networkLimit = statusResponse.data?.data.networkLimit ?? [];
        const setupType = networkLimit.includes('Mainnet')
          ? 'mainnet'
          : 'preprod';
        router.push(`/setup?type=${setupType}`);
      } else {
        router.push('/');
      }
    } catch (error: unknown) {
      const apiError = error as ApiError;
      const errorMessage =
        apiError.error?.message ??
        apiError.message ??
        'Invalid Key, check the entered data';
      setError(errorMessage);
      localStorage.removeItem('payment_api_key');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Head>
        <title>Sign In | Admin Interface</title>
      </Head>
      <Header />

      <main className="flex flex-col items-center justify-center min-h-screen py-20">
        <h1 className="text-4xl font-bold mb-4">Enter your Admin Key</h1>

        <p className="text-sm text-muted-foreground mb-8 text-center max-w-md">
          Your admin key is needed to access the dashboard. This key is required
          to manage your ai agents, payment settings and view transactions.
        </p>

        <Button
          variant="muted"
          className="text-sm mb-8 hover:underline"
          asChild
        >
          <Link href={'https://docs.masumi.network/'} target="_blank">
            Learn more
          </Link>
        </Button>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleApiKeySubmit(apiKey);
          }}
          className="flex flex-col items-center gap-2 w-full max-w-[500px]"
        >
          <div className="flex gap-4 items-center w-full">
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Admin Key"
              required
              className={cn(
                'flex-1 bg-transparent',
                error && 'border-red-500 focus-visible:ring-red-500',
              )}
            />
            <Button type="submit" disabled={isLoading} size="lg">
              {isLoading ? 'Validating...' : 'Enter'}
            </Button>
          </div>
          {error && <p className="text-red-500 text-sm self-start">{error}</p>}
        </form>
      </main>

      <Footer />
    </div>
  );
}
