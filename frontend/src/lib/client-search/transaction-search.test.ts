import assert from 'node:assert/strict';
import test from 'node:test';
import { filterTransactionsClientSide } from './transaction-search';

const rows = [
  {
    id: 'tx-a',
    type: 'payment',
    onChainState: 'FundsLocked',
    inputHash: 'abcdef123456',
    CurrentTransaction: { txHash: 'deadbeef00', layer: 'L2', hydraHeadId: null },
    RequestedFunds: [{ amount: '1500000', unit: '' }],
    PaidFunds: [{ amount: '9000000', unit: '' }],
  },
  {
    id: 'tx-b',
    type: 'purchase',
    onChainState: 'ResultSubmitted',
    CurrentTransaction: { txHash: 'cafebabe00', layer: 'L1', hydraHeadId: null },
    RequestedFunds: [{ amount: '1500000', unit: '' }],
    PaidFunds: [{ amount: '3000000', unit: '' }],
  },
];

const ids = (query: string) => filterTransactionsClientSide(rows, query).map((r) => r.id);

test('empty or whitespace query returns all rows', () => {
  assert.deepEqual(ids('  '), ['tx-a', 'tx-b']);
});

test('hash columns need a hex query of 5+ characters', () => {
  assert.deepEqual(ids('dead'), []);
  assert.deepEqual(ids('DEADB'), ['tx-a']);
  assert.deepEqual(ids('abcdef'), ['tx-a']);
});

test('hydra aliases the L2 layer', () => {
  assert.deepEqual(ids('hydra'), ['tx-a']);
  assert.deepEqual(ids('l1'), ['tx-b']);
});

test('state matches raw and spaced labels', () => {
  assert.deepEqual(ids('result submitted'), ['tx-b']);
  assert.deepEqual(ids('fundslocked'), ['tx-a']);
});

test('amount range uses RequestedFunds for payments and PaidFunds for purchases', () => {
  assert.deepEqual(ids('1.5'), ['tx-a']);
  assert.deepEqual(ids('3'), ['tx-b']);
  assert.deepEqual(ids('9'), []);
});
