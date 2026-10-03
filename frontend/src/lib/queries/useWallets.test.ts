import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ContextType } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppContext } from '@/lib/contexts/AppContext';
import { createClient } from '@/lib/api/generated/client';
import type { WalletListItem } from '@/lib/api/generated';
import { usePaginatedWallets } from './useWallets';

function setup() {
  const requests: URL[] = [];
  const wallets: WalletListItem[] = Array.from({ length: 7 }, (_, index) => ({
    id: `wallet-${index + 1}`,
    paymentSourceId: 'source-1',
    walletVkey: `key-${index + 1}`,
    walletAddress: `addr_test1_${index + 1}`,
    collectionAddress: null,
    type: 'Selling',
    isGuarded: false,
    note: index >= 5 ? 'Treasury' : 'Ordinary',
    LowBalanceSummary: { isLow: false, lowRuleCount: 0, lastCheckedAt: null },
  }));
  const apiClient = createClient({
    baseURL: 'http://wallet.test',
    adapter: async (config) => {
      const url = new URL(config.url!);
      let data;
      if (url.pathname === '/wallet/list') {
        requests.push(url);
        const search = url.searchParams.get('searchQuery')?.toLowerCase();
        const matching = wallets.filter(
          (wallet) => !search || wallet.note?.toLowerCase().includes(search),
        );
        const cursor = url.searchParams.get('cursorId');
        const start = cursor ? matching.findIndex((wallet) => wallet.id === cursor) : 0;
        data = { Wallets: matching.slice(start, start + Number(url.searchParams.get('take'))) };
      } else {
        assert.equal(url.pathname, '/balance');
        data = { Balance: [] };
      }
      return {
        data: { status: 'success', data },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    },
  });
  const context = {
    apiClient,
    selectedPaymentSourceId: 'source-1',
    selectedPaymentSource: { id: 'source-1', network: 'Preprod' },
  } as NonNullable<ContextType<typeof AppContext>>;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function render(search?: string) {
    function Wallets() {
      usePaginatedWallets('Selling', search);
      return null;
    }
    renderToString(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AppContext.Provider, { value: context }, createElement(Wallets)),
      ),
    );
    return queryClient.getQueryCache().getAll().at(-1)!;
  }

  return { requests, queryClient, render };
}

test('wallet search finds a match beyond the first unfiltered page', async () => {
  const { requests, queryClient, render } = setup();
  try {
    const initial = await render().fetch();
    assert.equal(
      (initial as { pages: { wallets: WalletListItem[] }[] }).pages[0].wallets.length,
      5,
    );
    const result = await render('  TREASURY  ').fetch();
    assert.deepEqual(
      (result as { pages: { wallets: WalletListItem[] }[] }).pages[0].wallets.map(
        (wallet) => wallet.id,
      ),
      ['wallet-6', 'wallet-7'],
    );
    assert.equal(requests.at(-1)!.searchParams.get('searchQuery'), 'treasury');
  } finally {
    queryClient.clear();
  }
});

test('changing wallet search starts without the previous cursor and blank search reuses the unfiltered query', async () => {
  const { requests, queryClient, render } = setup();
  try {
    const unfiltered = render();
    await unfiltered.fetch();
    await unfiltered.fetch(undefined, { meta: { fetchMore: { direction: 'forward' } } });
    assert.equal(requests.at(-1)!.searchParams.get('cursorId'), 'wallet-5');
    const searched = render('treasury');
    assert.notDeepEqual(searched.queryKey, unfiltered.queryKey);
    await searched.fetch();
    assert.equal(requests.at(-1)!.searchParams.get('cursorId'), null);
    render('  TREASURY ');
    assert.equal(queryClient.getQueryCache().getAll().length, 2);
    render('   ');
    assert.equal(queryClient.getQueryCache().getAll().length, 2);
  } finally {
    queryClient.clear();
  }
});
