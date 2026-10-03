import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTransactionReportBody,
  buildTransactionReportViewDefaults,
  createTransactionReportForm,
  filterAccessibleReportWalletIds,
  toggleReportFilterValue,
  toggleReportWalletSelection,
} from './download-details.helpers';
import { EMPTY_FILTERS } from './TransactionFilters';

test('maps payment and state view filters to seller report defaults', () => {
  assert.deepEqual(
    buildTransactionReportViewDefaults(
      'Purchases',
      { ...EMPTY_FILTERS, type: 'payment', status: 'Withdrawn' },
      false,
    ),
    {
      roles: ['Seller'],
      states: ['Withdrawn'],
      hasUnmappedFilters: false,
    },
  );
});

test('maps payment and purchase tabs to seller and buyer roles', () => {
  assert.deepEqual(buildTransactionReportViewDefaults('Payments', EMPTY_FILTERS, false).roles, [
    'Seller',
  ]);
  assert.deepEqual(buildTransactionReportViewDefaults('Purchases', EMPTY_FILTERS, false).roles, [
    'Buyer',
  ]);
});

test('marks search and action-only filters as unmapped report filters', () => {
  assert.equal(
    buildTransactionReportViewDefaults(
      'Needs Action',
      { ...EMPTY_FILTERS, errorType: 'NetworkError' },
      true,
    ).hasUnmappedFilters,
    true,
  );
});

test('builds default report body and omits all-wallet and all-state filters', () => {
  const form = createTransactionReportForm(
    'source-1',
    { roles: ['Buyer', 'Seller'], states: [], hasUnmappedFilters: false },
    'Europe/Prague',
  );
  const now = new Date('2026-08-24T12:00:00.000Z');
  const result = buildTransactionReportBody(form, now);

  assert.equal(result.error, null);
  assert.ok(result.body);
  assert.equal(result.body.paymentSourceId, 'source-1');
  assert.equal(result.body.managedWalletIds, undefined);
  assert.equal(result.body.states, undefined);
  assert.equal(result.body.timeZone, 'Europe/Prague');
  assert.equal(result.body.bucket, 'Auto');
  assert.equal(result.body.to?.getTime(), now.getTime());
  assert.equal(result.body.from?.getTime(), now.getTime() - 30 * 24 * 60 * 60 * 1000);
});

test('removes wallet filters that are no longer present in accessible report facets', () => {
  const wallets = [
    { id: 'wallet-a', paymentSourceId: 'source-1' },
    { id: 'wallet-b', paymentSourceId: 'source-2' },
  ];

  assert.deepEqual(
    filterAccessibleReportWalletIds(['wallet-a', 'wallet-revoked'], wallets, 'source-1'),
    ['wallet-a'],
  );
  assert.deepEqual(filterAccessibleReportWalletIds(['wallet-b'], wallets, 'source-1'), []);
});

test('uses the selected IANA time zone for an inclusive custom report range', () => {
  const form = {
    ...createTransactionReportForm(
      'source-1',
      { roles: ['Buyer'], states: [], hasUnmappedFilters: false },
      'Pacific/Kiritimati',
    ),
    datePreset: 'custom' as const,
    customStartDate: '2026-01-02',
    customEndDate: '2026-01-02',
  };
  const result = buildTransactionReportBody(form);

  assert.equal(result.error, null);
  assert.equal(result.body?.from?.toISOString(), '2026-01-01T10:00:00.000Z');
  assert.equal(result.body?.to?.toISOString(), '2026-01-02T10:00:00.000Z');
});

test('keeps an inclusive custom range on a 23-hour DST day', () => {
  const form = {
    ...createTransactionReportForm(
      'source-1',
      { roles: ['Buyer'], states: [], hasUnmappedFilters: false },
      'America/New_York',
    ),
    datePreset: 'custom' as const,
    customStartDate: '2026-03-08',
    customEndDate: '2026-03-08',
  };
  const result = buildTransactionReportBody(form);

  assert.equal(result.error, null);
  assert.equal(result.body?.from?.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(result.body?.to?.toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(
    (result.body?.to?.getTime() ?? 0) - (result.body?.from?.getTime() ?? 0),
    23 * 60 * 60 * 1000,
  );
});

test('maps wallet, address, role, and state selections without duplicates', () => {
  const form = {
    ...createTransactionReportForm(
      'source-1',
      { roles: ['Seller'], states: ['Withdrawn'], hasUnmappedFilters: false },
      'Etc/UTC',
    ),
    managedWalletIds: ['wallet-1'],
    externalAddressesText: 'addr_test1, addr_test2\naddr_test1',
    bucket: 'Week' as const,
  };
  const result = buildTransactionReportBody(form, new Date('2026-08-24T12:00:00.000Z'));

  assert.equal(result.error, null);
  assert.deepEqual(result.body?.managedWalletIds, ['wallet-1']);
  assert.deepEqual(result.body?.externalAddresses, ['addr_test1', 'addr_test2']);
  assert.deepEqual(result.body?.roles, ['Seller']);
  assert.deepEqual(result.body?.states, ['Withdrawn']);
  assert.equal(result.body?.bucket, 'Week');
});

test('maps the Pending report state sentinel', () => {
  const form = createTransactionReportForm(
    'source-1',
    { roles: ['Buyer'], states: ['Pending'], hasUnmappedFilters: false },
    'Etc/UTC',
  );

  assert.deepEqual(
    buildTransactionReportBody(form, new Date('2026-08-24T12:00:00.000Z')).body?.states,
    ['Pending'],
  );
});

test('rejects a report with no selected role', () => {
  const form = {
    ...createTransactionReportForm(
      'source-1',
      { roles: ['Buyer'], states: [], hasUnmappedFilters: false },
      'Etc/UTC',
    ),
    roles: [],
  };

  assert.deepEqual(buildTransactionReportBody(form), {
    body: null,
    error: 'Select at least one role.',
  });
});

test('rejects a blank report time zone before requesting a summary', () => {
  const form = {
    ...createTransactionReportForm(
      'source-1',
      { roles: ['Buyer'], states: [], hasUnmappedFilters: false },
      'Etc/UTC',
    ),
    timeZone: '  ',
  };

  assert.deepEqual(buildTransactionReportBody(form), {
    body: null,
    error: 'Enter an IANA time zone.',
  });
});

test('toggles multi-value report filters', () => {
  assert.deepEqual(toggleReportFilterValue(['Buyer'], 'Seller'), ['Buyer', 'Seller']);
  assert.deepEqual(toggleReportFilterValue(['Buyer', 'Seller'], 'Buyer'), ['Seller']);
});

test('adopts an auto-selected payment source before selecting its first wallet', () => {
  const form = createTransactionReportForm(
    '',
    { roles: ['Buyer', 'Seller'], states: [], hasUnmappedFilters: false },
    'Etc/UTC',
  );

  const selected = toggleReportWalletSelection(form, 'source-1', 'wallet-1');

  assert.equal(selected.paymentSourceId, 'source-1');
  assert.deepEqual(selected.managedWalletIds, ['wallet-1']);
  assert.deepEqual(
    toggleReportWalletSelection(selected, 'source-1', 'wallet-1').managedWalletIds,
    [],
  );
});
