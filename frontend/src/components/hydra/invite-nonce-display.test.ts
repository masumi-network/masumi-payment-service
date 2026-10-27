import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HydraHeadTable } from './HydraHeadTable';
import type { HydraInvite } from '@/lib/hooks/useHydraHeads';

test('the head list does not expose an unredeemed invite nonce', () => {
  const nonce = 'invite-secret-123456789';
  const invite: HydraInvite = {
    id: 'invite-record-123456789',
    nonce,
    network: 'Preprod',
    role: 'Issuer',
    status: 'Issued',
    createdAt: '2026-10-27T00:00:00.000Z',
    expiresAt: '2026-10-28T00:00:00.000Z',
    hydraHostId: 'host-1',
    hostNodeId: 'node-1',
    issuerWalletAddress: 'addr_test1issuer',
    issuerExchangeUrl: 'https://example.test',
    redeemedAt: null,
    redeemerWalletAddress: null,
    hydraHeadId: null,
  };

  const markup = renderToStaticMarkup(
    createElement(HydraHeadTable, {
      heads: [],
      pendingInvites: [invite],
      hostNames: {},
      isLoading: false,
      hasActiveFilters: false,
      runningLifecycleHeadId: null,
      onOpenHead: () => {},
      onRequestLifecycle: () => {},
      onManageInvites: () => {},
    }),
  );

  assert.match(markup, /Invite invite-r/);
  assert.doesNotMatch(markup, /invite-secret/);
});
