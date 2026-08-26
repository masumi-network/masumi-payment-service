import assert from 'node:assert/strict';
import test from 'node:test';
import {
  paginateReportRows,
  REPORT_TABLE_PAGE_SIZE,
  resetReportTablePageState,
} from './report-rendering';

test('report table pagination clamps stale pages and exposes one bounded slice', () => {
  const rows = Array.from({ length: REPORT_TABLE_PAGE_SIZE * 2 + 3 }, (_, index) => index);
  const first = paginateReportRows(rows, 0);
  const last = paginateReportRows(rows, 99);

  assert.deepEqual(first.items, rows.slice(0, REPORT_TABLE_PAGE_SIZE));
  assert.equal(first.page, 0);
  assert.equal(first.pageCount, 3);
  assert.equal(first.startIndex, 0);
  assert.equal(first.endIndex, REPORT_TABLE_PAGE_SIZE);
  assert.deepEqual(last.items, rows.slice(REPORT_TABLE_PAGE_SIZE * 2));
  assert.equal(last.page, 2);
  assert.equal(last.startIndex, REPORT_TABLE_PAGE_SIZE * 2);
  assert.equal(last.endIndex, rows.length);
});

test('report table pagination resets when a same-sized report dataset replaces the old one', () => {
  const oldDataset = [{ id: 'old-1' }, { id: 'old-2' }];
  const newDataset = [{ id: 'new-1' }, { id: 'new-2' }];
  const previousState = { dataset: oldDataset, page: 3 };

  assert.equal(resetReportTablePageState(previousState, oldDataset), previousState);
  assert.deepEqual(resetReportTablePageState(previousState, newDataset), {
    dataset: newDataset,
    page: 0,
  });
});
