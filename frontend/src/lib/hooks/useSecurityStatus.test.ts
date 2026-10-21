import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ContextType } from 'react';
import { renderToString } from 'react-dom/server';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppContext } from '@/lib/contexts/AppContext';
import { createClient } from '@/lib/api/generated/client';
import { useSecurityStatus } from './useSecurityStatus';

type Reply = { status: number; data: unknown };

function fetchSecurityStatus(reply: Reply) {
  const apiClient = createClient({
    baseURL: 'http://security.test',
    adapter: async (config: InternalAxiosRequestConfig) => {
      const response = { ...reply, statusText: '', headers: {}, config };
      if (reply.status >= 400) {
        throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, response);
      }
      return response;
    },
  });
  const context = {
    apiClient,
    capabilities: { canAdmin: true },
  } as NonNullable<ContextType<typeof AppContext>>;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function SecurityStatus() {
    useSecurityStatus();
    return null;
  }
  renderToString(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(AppContext.Provider, { value: context }, createElement(SecurityStatus)),
    ),
  );
  return queryClient.getQueryCache().getAll().at(-1)!.fetch();
}

test('returns the security status of a successful check', async () => {
  const status = await fetchSecurityStatus({
    status: 200,
    data: { status: 'success', data: { isEncryptionKeyPublic: true } },
  });
  assert.deepEqual(status, { isEncryptionKeyPublic: true });
});

// An empty error body is falsy. Caching it as "no warning" would hide the
// banner for the whole session, because the query never goes stale.
test('fails on a bare 502 so the check is not cached as no warning', async () => {
  await assert.rejects(fetchSecurityStatus({ status: 502, data: '' }));
});
