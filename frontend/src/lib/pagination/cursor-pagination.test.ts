import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendInclusiveCursorPage,
  buildExclusiveCursorPage,
  flattenInclusiveCursorPages,
} from './cursor-pagination';

test('appendInclusiveCursorPage removes the repeated boundary row', () => {
  const merged = appendInclusiveCursorPage(
    [{ id: 'a' }, { id: 'b' }],
    [{ id: 'b' }, { id: 'c' }],
    (item) => item.id,
  );

  assert.deepEqual(
    merged.map((item) => item.id),
    ['a', 'b', 'c'],
  );
});

test('flattenInclusiveCursorPages keeps only one copy of inclusive cursor overlaps', () => {
  const merged = flattenInclusiveCursorPages(
    [
      [{ id: 'page-1' }, { id: 'page-2' }],
      [{ id: 'page-2' }, { id: 'page-3' }],
      [{ id: 'page-3' }, { id: 'page-4' }],
    ],
    (item) => item.id,
  );

  assert.deepEqual(
    merged.map((item) => item.id),
    ['page-1', 'page-2', 'page-3', 'page-4'],
  );
});

test('buildExclusiveCursorPage keeps invoice-style exclusive pagination unchanged', () => {
  const page = buildExclusiveCursorPage(
    [{ id: 'invoice-1' }, { id: 'invoice-2' }, { id: 'invoice-3' }],
    2,
    (item) => item.id,
  );

  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, 'invoice-2');
  assert.deepEqual(
    page.items.map((item) => item.id),
    ['invoice-1', 'invoice-2'],
  );
});
