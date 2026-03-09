import { getSwapConfirm } from '@/lib/api/generated';
import { useCallback, useEffect, useRef } from 'react';
import { extractSwapConfirmPayload, type SwapConfirmPayload } from './swap-api';

type UseSwapStatusPollingOptions = {
  apiClient: Parameters<typeof getSwapConfirm>[0]['client'];
  walletVkey?: string;
  pollIntervalMs?: number;
  maxPollMs?: number;
  onUpdate: (payload: SwapConfirmPayload) => boolean | void;
  onTimeout: () => void;
  onError?: () => void;
};

export function useSwapStatusPolling({
  apiClient,
  walletVkey,
  pollIntervalMs = 4000,
  maxPollMs = 5 * 60 * 1000,
  onUpdate,
  onTimeout,
  onError,
}: UseSwapStatusPollingOptions) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const onUpdateRef = useRef(onUpdate);
  const onTimeoutRef = useRef(onTimeout);
  const onErrorRef = useRef(onError);
  onUpdateRef.current = onUpdate;
  onTimeoutRef.current = onTimeout;
  onErrorRef.current = onError;

  const stopPolling = useCallback(() => {
    cancelledRef.current = true;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (txHash: string) => {
      if (!walletVkey) {
        return;
      }

      cancelledRef.current = false;
      const startedAt = Date.now();

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      const poll = async () => {
        if (cancelledRef.current) {
          return;
        }

        if (Date.now() - startedAt > maxPollMs) {
          stopPolling();
          onTimeoutRef.current();
          return;
        }

        try {
          const confirmResult = await getSwapConfirm({
            client: apiClient,
            query: { txHash, walletVkey },
          });

          if (cancelledRef.current) {
            return;
          }

          const shouldStop = onUpdateRef.current(extractSwapConfirmPayload(confirmResult));
          if (shouldStop) {
            stopPolling();
            return;
          }
        } catch {
          if (cancelledRef.current) {
            return;
          }

          onErrorRef.current?.();
        }

        timeoutRef.current = setTimeout(poll, pollIntervalMs);
      };

      timeoutRef.current = setTimeout(poll, pollIntervalMs);
    },
    [apiClient, maxPollMs, pollIntervalMs, stopPolling, walletVkey],
  );

  useEffect(() => stopPolling, [stopPolling]);

  return {
    startPolling,
    stopPolling,
  };
}
