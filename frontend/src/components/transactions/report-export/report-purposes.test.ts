import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TransactionReportFormState } from '../download-details.helpers';
import { applyReportPurpose, inferReportPurpose, reportPurposeShows } from './report-purposes';

const FORM: TransactionReportFormState = {
  paymentSourceId: 'source-1',
  managedWalletIds: ['wallet-1'],
  externalAddressesText: 'addr_test1qq',
  roles: ['Seller', 'Buyer'],
  states: ['Disputed'],
  datePreset: '30d',
  customStartDate: '',
  customEndDate: '',
  dateBasis: 'CreatedAt',
  revenueMode: 'CashReceived',
  bucket: 'Auto',
  timeZone: 'Europe/Prague',
  fiatCurrency: 'none',
  fiatMode: 'PeriodAverage',
};

describe('report export flows', () => {
  it('clears every filter the chosen flow hides', () => {
    const closed = applyReportPurpose(FORM, 'accounting');
    assert.deepEqual(closed.managedWalletIds, []);
    assert.deepEqual(closed.states, []);
    assert.equal(closed.externalAddressesText, '');
  });

  it('keeps the accounting rules a flow shows', () => {
    const closed = applyReportPurpose(FORM, 'accounting');
    assert.equal(closed.dateBasis, 'CreatedAt');
    assert.equal(closed.revenueMode, 'CashReceived');
  });

  it('resets the accounting rules a flow hides, so a hidden rule cannot change the figures', () => {
    const totals = applyReportPurpose(FORM, 'totals');
    assert.equal(totals.dateBasis, 'RevenueRecognizedAt');
    assert.equal(totals.revenueMode, 'Billable');
  });

  it('keeps wallets, states, and addresses under the custom flow', () => {
    assert.deepEqual(applyReportPurpose(FORM, 'custom'), FORM);
  });

  it('keeps the wallet filter when reconciling wallets', () => {
    const wallets = applyReportPurpose(FORM, 'wallets');
    assert.deepEqual(wallets.managedWalletIds, ['wallet-1']);
    assert.deepEqual(wallets.states, []);
  });

  it('never leaves the sides picker hidden, because no side means no rows', () => {
    for (const purpose of ['accounting', 'wallets', 'investigate', 'totals', 'custom'] as const) {
      assert.equal(reportPurposeShows(purpose, 'sides'), true);
    }
  });

  it('opens on the investigate flow when the caller already filtered by state', () => {
    assert.equal(inferReportPurpose({ ...FORM, managedWalletIds: [] }), 'investigate');
  });

  it('opens on the wallet flow when only wallets are filtered', () => {
    assert.equal(inferReportPurpose({ ...FORM, states: [], externalAddressesText: '' }), 'wallets');
  });

  it('opens on the accounting flow when nothing is filtered', () => {
    assert.equal(
      inferReportPurpose({
        ...FORM,
        managedWalletIds: [],
        states: [],
        externalAddressesText: '',
      }),
      'accounting',
    );
  });
});
