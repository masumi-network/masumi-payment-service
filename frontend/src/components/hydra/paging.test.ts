import assert from 'node:assert/strict';
import test from 'node:test';
import { movedPosition, pageOf, startOf } from './paging';

const rows = Array.from({ length: 23 }, (_, index) => index);
const withIds = (ids: string[]) => ids.map((id) => ({ id }));

test('first page holds the first rows', () => {
  const page = pageOf(rows, 0, 10);
  assert.deepEqual(page.items, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(page.page, 0);
  assert.equal(page.pageCount, 3);
  assert.equal(page.from, 1);
  assert.equal(page.to, 10);
  assert.equal(page.total, 23);
  assert.equal(page.pageSize, 10);
});

test('last page is short', () => {
  const page = pageOf(rows, 20, 10);
  assert.deepEqual(page.items, [20, 21, 22]);
  assert.equal(page.page, 2);
  assert.equal(page.from, 21);
  assert.equal(page.to, 23);
});

test('a start past the end moves back to the last full page of rows', () => {
  const page = pageOf(rows, 90, 10);
  assert.equal(page.start, 13);
  assert.equal(page.from, 14);
  assert.equal(page.to, 23);
});

test('Next past the loaded rows keeps the shown rows while the batch loads', () => {
  const page = pageOf(rows, 23, 10);
  assert.deepEqual(page.items, [13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
});

test('a list shorter than a page shows from the top', () => {
  assert.equal(pageOf([1, 2, 3], 10, 10).start, 0);
});

test('a negative start clamps to the first page', () => {
  assert.equal(pageOf(rows, -1, 10).start, 0);
});

test('an empty list is one empty page', () => {
  const page = pageOf([], 3, 10);
  assert.deepEqual(page.items, []);
  assert.equal(page.page, 0);
  assert.equal(page.pageCount, 1);
  assert.equal(page.from, 0);
  assert.equal(page.to, 0);
});

test('a start between page boundaries counts the partial page before it', () => {
  const page = pageOf(rows, 11, 10);
  assert.deepEqual(page.items, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(page.page, 2);
  assert.equal(page.pageCount, 4);
});

test('a page stays on its rows when a new row lands above it', () => {
  const before = withIds(['e', 'd', 'c', 'b', 'a']);
  const position = movedPosition(before, 0, 2, 1);
  assert.deepEqual(position, { start: 2, anchorId: 'c' });

  const after = withIds(['f', 'e', 'd', 'c', 'b', 'a']);
  const page = pageOf(after, startOf(after, position), 2);
  assert.deepEqual(
    page.items.map((row) => row.id),
    ['c', 'b'],
  );
});

test('the first page is not anchored, so new rows show on it', () => {
  const items = withIds(['c', 'b', 'a']);
  assert.deepEqual(movedPosition(items, 2, 2, -1), { start: 0, anchorId: null });
});

test('a page past the loaded rows has no anchor until they arrive', () => {
  const items = withIds(['b', 'a']);
  assert.deepEqual(movedPosition(items, 0, 2, 1), { start: 2, anchorId: null });
});

test('a vanished anchor falls back to the offset', () => {
  const items = withIds(['c', 'b', 'a']);
  assert.equal(startOf(items, { start: 2, anchorId: 'gone' }), 2);
});
