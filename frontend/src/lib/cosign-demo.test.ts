import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { setTimeout as delay } from 'node:timers/promises';
import {
  COSIGN_READ_TOKEN_QUERY_OPTIONS,
  needsReadToken,
  parseCosignDashboardUrl,
} from './cosign-demo';

test('parseCosignDashboardUrl allows https, and http only on loopback', () => {
  assert.equal(
    parseCosignDashboardUrl('https://cosign.exchain.network'),
    'https://cosign.exchain.network/',
  );
  assert.equal(parseCosignDashboardUrl('http://127.0.0.1:4600/'), 'http://127.0.0.1:4600/');
  assert.equal(parseCosignDashboardUrl('http://cosign.exchain.network'), null);
  assert.equal(parseCosignDashboardUrl('https://user:pass@cosign.exchain.network'), null);
  assert.equal(parseCosignDashboardUrl(''), null);
});

test('needsReadToken skips the local mock, which issues no tokens', () => {
  assert.equal(needsReadToken('https://cosign.exchain.network/'), true);
  assert.equal(needsReadToken('http://127.0.0.1:4600/'), false);
  assert.equal(needsReadToken('http://localhost:4600/'), false);
  assert.equal(needsReadToken(null), false);
});

test('mints a new read token when the dashboard reopens after renewal', async () => {
  const client = new QueryClient();
  let requests = 0;
  const options = {
    queryKey: ['exchain-read-token'],
    queryFn: async () => `token-${++requests}`,
    ...COSIGN_READ_TOKEN_QUERY_OPTIONS,
  };
  try {
    const initial = new QueryObserver(client, options);
    const leave = initial.subscribe(() => {});
    await initial.refetch();
    assert.equal(initial.getCurrentResult().data, 'token-1');
    // Renewal reaches the iframe, while the original URL remains in the query.
    assert.equal(await options.queryFn(), 'token-2');
    leave();
    await delay(10);
    const reopened = new QueryObserver(client, options);
    const close = reopened.subscribe(() => {});
    try {
      await delay(10);
      assert.equal(reopened.getCurrentResult().data, 'token-3');
    } finally {
      close();
    }
  } finally {
    client.clear();
  }
});
