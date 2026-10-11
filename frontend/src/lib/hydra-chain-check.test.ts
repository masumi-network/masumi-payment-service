import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeHydraHeadChainCheck, needsOperatorAction } from './hydra-chain-check';
import type { HydraHeadChainCheck } from './hydra-chain-check';

const check = (overrides: Partial<HydraHeadChainCheck>): HydraHeadChainCheck => ({
  chainState: 'open',
  latestTxHash: 'aa',
  nodeAction: 'stop',
  nodeOutcome: 'requested',
  ...overrides,
});

test('an open disabled head says its node was asked to stop', () => {
  const result = check({});
  assert.match(describeHydraHeadChainCheck(result), /asked to stop/);
  assert.equal(needsOperatorAction(result), false);
});

// Otherwise the counterparty keeps locking funds in a head this side ignores.
test('an open head whose node could not be stopped tells the operator to stop it', () => {
  for (const nodeOutcome of ['no-admin-token', 'failed', 'no-participant'] as const) {
    const result = check({ nodeOutcome });
    assert.match(describeHydraHeadChainCheck(result), /Stop the node on the host/);
    assert.equal(needsOperatorAction(result), true);
  }
});

test('a closed head whose node was started says it can contest', () => {
  const result = check({ chainState: 'closed', nodeAction: 'start' });
  assert.match(describeHydraHeadChainCheck(result), /asked to start/);
  assert.equal(needsOperatorAction(result), false);
});

// The operator must act by hand: the contestation period does not wait.
test('a closed head whose node could not be started tells the operator to start it', () => {
  for (const nodeOutcome of ['no-admin-token', 'failed', 'no-participant'] as const) {
    const result = check({ chainState: 'closed', nodeAction: 'start', nodeOutcome });
    assert.match(describeHydraHeadChainCheck(result), /Start it on the host now/);
    assert.equal(needsOperatorAction(result), true);
  }
});

test('a fanned-out head needs nothing', () => {
  const result = check({ chainState: 'gone', nodeAction: null, nodeOutcome: null });
  assert.match(describeHydraHeadChainCheck(result), /Fanned out/);
  assert.equal(needsOperatorAction(result), false);
});
