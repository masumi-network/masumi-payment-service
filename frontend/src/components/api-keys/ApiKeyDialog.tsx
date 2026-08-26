import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getApiKeyStatus, getPaymentSource } from '@/lib/api/generated';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import { capabilitiesFromApiKeyStatus, DEFAULT_CAPABILITIES } from '@/lib/permissions';

interface ApiError {
  message: string;
  error?: {
    message?: string;
  };
}

export function ApiKeyDialog() {
  const router = useRouter();
  const [apiKeyTMP, setApiKeyTMP] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { updateApiKey, setCapabilities, apiClient } = useAppContext();

  const handleApiKeySubmit = async (key: string) => {
    setError('');
    setIsLoading(true);
    // Drop the previous session's flags before the new key is in play. Without
    // this, signing in with a weaker key while stale capabilities say canPay
    // leaves pay-gated queries enabled for a beat and they 401.
    setCapabilities(DEFAULT_CAPABILITIES);

    try {
      apiClient.setConfig({ headers: { token: key } });

      const statusResponse = await getApiKeyStatus({
        client: apiClient,
      });

      const nextCapabilities = capabilitiesFromApiKeyStatus(statusResponse.data?.data);
      if (!nextCapabilities) {
        throw new Error('Invalid Key: Active key with read access required');
      }

      setCapabilities(nextCapabilities);

      const hexKey = Buffer.from(key).toString('hex');
      localStorage.setItem('payment_api_key', hexKey);

      const sourcesResponse = await getPaymentSource({
        client: apiClient,
      });

      const sources = sourcesResponse.data?.data?.PaymentSources ?? [];

      if (sources.length === 0 && nextCapabilities.canAdmin) {
        const networkLimit = statusResponse.data?.data.NetworkLimit ?? [];
        const setupType = networkLimit.includes('Mainnet') ? 'mainnet' : 'preprod';
        router.push(`/setup?type=${setupType}`);
      } else if (sources.length === 0) {
        router.push('/developers');
      } else {
        router.push('/');
      }

      updateApiKey(apiKeyTMP);
    } catch (error: unknown) {
      const apiError = error as ApiError;
      const errorMessage =
        apiError.error?.message ?? apiError.message ?? 'Invalid Key, check the entered data';
      setError(errorMessage);
      localStorage.removeItem('payment_api_key');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Head>
        <title>Sign In | Masumi Payment</title>
      </Head>
      <Header />

      <main className="flex flex-col items-center justify-center min-h-screen py-20">
        <h1 className="text-4xl font-bold mb-4">Enter your API Key</h1>

        <p className="text-sm text-muted-foreground mb-8 text-center max-w-md">
          Your API key is needed to access the dashboard. This key is required to manage your ai
          agents, payment settings and view transactions.
        </p>

        <Button variant="muted" className="text-sm mb-8 hover:underline" asChild>
          <Link
            href={'https://www.masumi.network/dev/masumi/'}
            target="_blank"
            rel="noopener noreferrer"
          >
            Learn more
          </Link>
        </Button>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleApiKeySubmit(apiKeyTMP);
          }}
          className="flex flex-col items-center gap-2 w-full max-w-[500px]"
        >
          <div className="flex gap-4 items-center w-full">
            <Input
              type="password"
              value={apiKeyTMP}
              onChange={(e) => setApiKeyTMP(e.target.value)}
              placeholder="API Key"
              required
              className={cn(
                'flex-1 bg-transparent',
                error && 'border-destructive focus-visible:ring-destructive',
              )}
            />
            <Button type="submit" disabled={isLoading} size="lg">
              {isLoading ? 'Validating...' : 'Enter'}
            </Button>
          </div>
          {error && <p className="text-destructive text-sm self-start">{error}</p>}
        </form>
      </main>

      <Footer />
    </div>
  );
}
