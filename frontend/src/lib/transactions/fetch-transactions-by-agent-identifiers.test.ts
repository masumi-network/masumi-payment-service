import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasMoreAgentIdentifierPages,
  initCursors,
} from './fetch-transactions-by-agent-identifiers';

test('initCursors marks skipped streams as exhausted', () => {
  const cursors = initCursors(['agent-a'], { skipPurchases: true });
  assert.equal(cursors[0]?.hasMorePayments, true);
  assert.equal(cursors[0]?.hasMorePurchases, false);
  assert.equal(hasMoreAgentIdentifierPages(cursors), true);
});

test('hasMoreAgentIdentifierPages is false when active streams are exhausted', () => {
  const cursors = initCursors(['agent-a'], { skipPurchases: true });
  cursors[0]!.hasMorePayments = false;
  assert.equal(hasMoreAgentIdentifierPages(cursors), false);
});
