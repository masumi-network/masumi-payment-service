import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeHydraHeadChainCheck } from './hydra-chain-check';

test('an open head says L2 refunds still work', () => {
  const text = describeHydraHeadChainCheck({ chainState: 'open', latestTxHash: 'aa' });
  assert.match(text, /Still open on chain/);
  assert.match(text, /refunds/);
});

// The contestation period does not wait for the operator.
test('a closed head tells the operator to keep its node running', () => {
  const text = describeHydraHeadChainCheck({ chainState: 'closed', latestTxHash: 'bb' });
  assert.match(text, /node runs on the host/);
});

test('a fanned-out head is finished', () => {
  const text = describeHydraHeadChainCheck({ chainState: 'gone', latestTxHash: 'cc' });
  assert.match(text, /finished/);
});
