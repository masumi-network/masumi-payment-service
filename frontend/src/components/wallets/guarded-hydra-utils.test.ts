import assert from 'node:assert/strict';
import test from 'node:test';
import type { HydraHead } from '@/lib/hooks/hydra/types';
import {
  hasMoveInFlight,
  isRecoverable,
  openHeadsForWallet,
  periodUsePercent,
  type GuardedHydraState,
  type GuardedHydraTransfer,
} from './guarded-hydra-utils';

const head = (id: string, status: HydraHead['status'], walletId: string | null) =>
  ({
    id,
    status,
    LocalParticipant: walletId == null ? null : { walletId },
  }) as unknown as HydraHead;

const transfer = (overrides: Partial<GuardedHydraTransfer>): GuardedHydraTransfer => ({
  id: 't1',
  direction: 'Deposit',
  status: 'Submitted',
  hydraHeadId: 'h1',
  txHash: 'aa',
  walletUtxoRef: 'aa#0',
  signBefore: null,
  recoverableAt: new Date('2026-10-13T10:37:41Z'),
  submittedAt: null,
  confirmedAt: null,
  failureReason: null,
  createdAt: new Date('2026-10-13T10:22:45Z'),
  ...overrides,
});

const state = (overrides: Partial<GuardedHydraState>): GuardedHydraState => ({
  location: 'L1',
  hydraHeadId: null,
  walletUtxoRef: null,
  state: null,
  l1Error: null,
  transfers: [],
  ...overrides,
});

test('openHeadsForWallet keeps only open heads this hot wallet takes part in', () => {
  const heads = [
    head('a', 'Open', 'w1'),
    head('b', 'Closed', 'w1'),
    head('c', 'Open', 'w2'),
    head('d', 'Open', null),
  ];
  assert.deepEqual(
    openHeadsForWallet(heads, 'w1').map((h) => h.id),
    ['a'],
  );
});

test('hasMoveInFlight polls while a move is open or the location is unknown', () => {
  assert.equal(hasMoveInFlight(null), false);
  assert.equal(hasMoveInFlight(state({})), false);
  assert.equal(hasMoveInFlight(state({ location: 'Unknown' })), true);
  assert.equal(hasMoveInFlight(state({ transfers: [transfer({ status: 'Prepared' })] })), true);
  assert.equal(hasMoveInFlight(state({ transfers: [transfer({ status: 'Confirmed' })] })), false);
});

test('isRecoverable needs a submitted deposit past its recoverable time', () => {
  const after = new Date('2026-10-13T10:40:00Z');
  const before = new Date('2026-10-13T10:30:00Z');
  assert.equal(isRecoverable(transfer({}), after), true);
  assert.equal(isRecoverable(transfer({}), before), false);
  assert.equal(isRecoverable(transfer({ status: 'Confirmed' }), after), false);
  assert.equal(isRecoverable(transfer({ direction: 'Withdraw' }), after), false);
  assert.equal(isRecoverable(transfer({ recoverableAt: null }), after), false);
});

test('periodUsePercent clamps to 0..100 and survives a zero limit', () => {
  assert.equal(periodUsePercent('5000000', '50000000'), 10);
  assert.equal(periodUsePercent('0', '50000000'), 0);
  assert.equal(periodUsePercent('60000000', '50000000'), 100);
  assert.equal(periodUsePercent('1', '0'), 0);
});
