import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSearchTransactionsByAgentName } from './agent-name-search';

test('shouldSearchTransactionsByAgentName matches plausible agent names', () => {
  assert.equal(shouldSearchTransactionsByAgentName('Phone'), true);
  assert.equal(shouldSearchTransactionsByAgentName('my agent'), true);
});

test('shouldSearchTransactionsByAgentName rejects amounts, hashes, and short queries', () => {
  assert.equal(shouldSearchTransactionsByAgentName(''), false);
  assert.equal(shouldSearchTransactionsByAgentName('a'), false);
  assert.equal(shouldSearchTransactionsByAgentName('12.5'), false);
  assert.equal(shouldSearchTransactionsByAgentName('a'.repeat(64)), false);
  assert.equal(shouldSearchTransactionsByAgentName('abc123def'), false);
});
