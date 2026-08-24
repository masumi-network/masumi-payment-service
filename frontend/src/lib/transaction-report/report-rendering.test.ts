import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decimateReportChartPoints,
  paginateReportRows,
  REPORT_CHART_POINT_LIMIT,
  REPORT_TABLE_PAGE_SIZE,
  resetReportTablePageState,
} from './report-rendering';

test('chart decimation bounds SVG nodes while preserving endpoints and local extremes', () => {
  const points = Array.from({ length: REPORT_CHART_POINT_LIMIT * 4 }, (_, index) => ({
    x: index,
    y: index === 400 ? -1_000 : index === 401 ? 1_000 : 0,
  }));

  const visible = decimateReportChartPoints(points);

  assert.ok(visible.length <= REPORT_CHART_POINT_LIMIT);
  assert.equal(visible[0], points[0]);
  assert.equal(visible.at(-1), points.at(-1));
  assert.ok(visible.includes(points[400]));
  assert.ok(visible.includes(points[401]));
});

test('chart decimation preserves an unknown gap without exceeding the marker limit', () => {
  const points = Array.from({ length: 1_000 }, (_, index) => ({
    x: index,
    y: 0,
    isUnknown: index === 333,
  }));

  const visible = decimateReportChartPoints(points, 10);

  assert.ok(visible.includes(points[333]));
  assert.ok(visible.filter((point) => !point.isUnknown).length <= 10);
});

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
