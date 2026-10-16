import assert from 'node:assert/strict';
import test from 'node:test';
import { joinInclusivePages, nextInclusiveCursor } from './inclusive-pages';

const row = (id: string) => ({ id });

test('pages that repeat the cursor row join without duplicates', () => {
  const joined = joinInclusivePages([
    [row('a'), row('b'), row('c')],
    [row('c'), row('d'), row('e')],
    [row('e'), row('f')],
  ]);
  assert.deepEqual(
    joined.map((entry) => entry.id),
    ['a', 'b', 'c', 'd', 'e', 'f'],
  );
});

test('no pages is an empty list', () => {
  assert.deepEqual(joinInclusivePages([]), []);
});

test('a full page continues from its last row', () => {
  assert.equal(nextInclusiveCursor([row('a'), row('b'), row('c')], 3), 'c');
});

test('a short page is the end', () => {
  assert.equal(nextInclusiveCursor([row('a'), row('b')], 3), undefined);
  assert.equal(nextInclusiveCursor([], 3), undefined);
});
