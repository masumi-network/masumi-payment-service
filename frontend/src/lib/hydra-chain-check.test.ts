import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeHydraHeadChainCheck } from './hydra-chain-check';

test('an open head keeps its node stopped', () => {
  const text = describeHydraHeadChainCheck({
    isOpenOnChain: true,
    latestTxHash: 'aa',
    nodeStart: null,
  });
  assert.match(text, /Still open on chain/);
});

test('a closed head whose node was started says it can contest', () => {
  const text = describeHydraHeadChainCheck({
    isOpenOnChain: false,
    latestTxHash: 'bb',
    nodeStart: 'requested',
  });
  assert.match(text, /asked to start/);
});

// The operator must act by hand: the contestation period does not wait.
test('a closed head whose node could not be started tells the operator to start it', () => {
  for (const nodeStart of ['no-admin-token', 'failed', 'no-participant'] as const) {
    const text = describeHydraHeadChainCheck({
      isOpenOnChain: false,
      latestTxHash: 'bb',
      nodeStart,
    });
    assert.match(text, /Start (it|the node) on the host now/);
  }
});
