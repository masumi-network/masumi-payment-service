/**
 * Read a disabled head's state on L1 by hand.
 *
 * A disabled head's node is stopped, and a stopped node cannot contest. The
 * service checks every disabled head on a schedule and wakes its node once the
 * head is closed on chain; this runs the same check now.
 */

import { useCallback, useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { extractApiErrorMessage } from '@/lib/api-error';
import { handleApiCall } from '@/lib/utils';
import type { Client } from '@/lib/api/generated/client';
import { ensureData } from './api';
import type { ApiEnvelope } from './api';
import type { HydraHeadChainCheck } from '@/lib/hydra-chain-check';

export async function checkHydraHeadOnChain(apiClient: Client, id: string) {
  let apiError: unknown = null;
  const response = await handleApiCall(
    () =>
      apiClient.post<{ 200: ApiEnvelope<HydraHeadChainCheck> }>({
        responseType: 'json',
        url: '/hydra/head/chain-check',
        body: { id },
      }),
    {
      errorMessage: 'Failed to check the Hydra head on chain',
      onError: (error: unknown) => {
        apiError = error;
      },
    },
  );
  if (apiError !== null) {
    throw new Error(extractApiErrorMessage(apiError, 'Failed to check the Hydra head on chain'));
  }
  return ensureData(response?.data?.data, 'The chain check result was not returned by the API');
}

export function useHydraHeadChainCheck(headId: string) {
  const { apiClient } = useAppContext();
  const [isChecking, setIsChecking] = useState(false);
  const [result, setResult] = useState<HydraHeadChainCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setIsChecking(true);
    setError(null);
    try {
      setResult(await checkHydraHeadOnChain(apiClient, headId));
    } catch (checkError) {
      setResult(null);
      setError(checkError instanceof Error ? checkError.message : 'The chain check failed');
    } finally {
      setIsChecking(false);
    }
  }, [apiClient, headId]);

  return { check, isChecking, result, error };
}
