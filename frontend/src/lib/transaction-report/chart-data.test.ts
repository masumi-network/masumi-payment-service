import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReportSummary } from './dashboard-metrics';
import {
  buildReportChartRows,
  decimateReportChartRows,
  formatReportAxisValue,
  REPORT_CHART_BUCKET_LIMIT,
  toReportChartValue,
  type ReportChartRow,
} from './chart-data';

type Completeness = 'complete' | 'partial';

function metric(rawAmount: string | null, completeness: Completeness = 'complete') {
  return {
    amounts:
      rawAmount == null
        ? []
        : [
            {
              unit: 'lovelace',
              rawAmount,
              decimalAmount: (Number(rawAmount) / 1_000_000).toFixed(6),
              decimals: 6,
              symbol: 'ADA',
            },
          ],
    completeness,
  };
}

function aggregate(rawAmount: string | null, completeness: Completeness = 'complete') {
  const entry = metric(rawAmount, completeness);
  return {
    transactionCount: 1,
    transactionCountCompleteness: completeness,
    sellerGrossRevenue: entry,
    protocolFees: entry,
    sellerCardanoFees: entry,
    actorCardanoFees: entry,
    sellerNetRevenue: entry,
    buyerGrossSpend: entry,
    returnedFunds: entry,
    buyerCardanoFees: entry,
    buyerNetSpend: entry,
    adminCardanoFees: entry,
    totalCardanoFees: entry,
  };
}

function summaryWith(
  buckets: ReadonlyArray<{ rawAmount: string | null; completeness?: Completeness }>,
): ReportSummary {
  return {
    totals: aggregate('0'),
    wallets: [],
    history: buckets.map((bucket, index) => ({
      bucketStart: new Date(Date.UTC(2026, 0, index + 1)),
      bucketEnd: new Date(Date.UTC(2026, 0, index + 2)),
      metrics: aggregate(bucket.rawAmount, bucket.completeness ?? 'complete'),
    })),
    bucket: 'Day',
    metadata: {
      generatedAt: new Date(Date.UTC(2026, 0, 10)),
      asOf: new Date(Date.UTC(2026, 0, 10)),
      paymentSource: {} as ReportSummary['metadata']['paymentSource'],
      filters: { timeZone: 'Etc/UTC' } as ReportSummary['metadata']['filters'],
      fiat: null,
      warnings: [],
    },
  } as ReportSummary;
}

test('chart values prefer the decimal amount over the raw smallest unit', () => {
  assert.equal(toReportChartValue('1500000', '1.500000', 6), 1.5);
  assert.equal(toReportChartValue('1500000', null, 6), 1.5);
  assert.equal(toReportChartValue('1500000', null, null), 1_500_000);
  assert.equal(toReportChartValue(null, null, 6), null);
  assert.equal(toReportChartValue('not-a-number', null, 6), null);
});

test('a partial bucket with no amount plots as a gap, not as zero', () => {
  const rows = buildReportChartRows(
    summaryWith([
      { rawAmount: '2000000' },
      { rawAmount: null, completeness: 'partial' },
      { rawAmount: '4000000' },
    ]),
    'lovelace',
    ['sellerGrossRevenue'],
  );

  assert.deepEqual(
    rows.map((row) => row.sellerGrossRevenue),
    [2, null, 4],
  );
  assert.deepEqual(
    rows.map((row) => row.bucketPartial),
    [false, true, false],
  );
});

test('a complete bucket with no amount plots as zero', () => {
  const rows = buildReportChartRows(summaryWith([{ rawAmount: null }]), 'lovelace', [
    'sellerGrossRevenue',
  ]);

  assert.equal(rows[0].sellerGrossRevenue, 0);
  assert.equal(rows[0].bucketPartial, false);
});

test('every bucket carries its displayed amount string for the tooltip', () => {
  const rows = buildReportChartRows(summaryWith([{ rawAmount: '2000000' }]), 'lovelace', [
    'sellerGrossRevenue',
  ]);

  // Same rounding as the cards. Full precision lives in the exports.
  assert.equal(rows[0].bucketTexts.sellerGrossRevenue, '2.00 ADA');
  assert.equal(rows[0].bucketTitle, 'Jan 1, 2026');
});

test('decimation bounds the point count and keeps both endpoints', () => {
  const rows = Array.from(
    { length: REPORT_CHART_BUCKET_LIMIT * 3 },
    (_, index) => ({ bucketLabel: String(index) }) as ReportChartRow,
  );

  const sampled = decimateReportChartRows(rows);

  assert.ok(sampled.length <= REPORT_CHART_BUCKET_LIMIT);
  assert.equal(sampled[0], rows[0]);
  assert.equal(sampled.at(-1), rows.at(-1));
});

test('short histories are never resampled', () => {
  const rows = Array.from(
    { length: 5 },
    (_, index) => ({ bucketLabel: String(index) }) as ReportChartRow,
  );

  assert.equal(decimateReportChartRows(rows), rows);
});

test('axis ticks stay short across magnitudes', () => {
  assert.equal(formatReportAxisValue(0), '0');
  assert.equal(formatReportAxisValue(0.25), '0.25');
  assert.equal(formatReportAxisValue(1_200), '1.2k');
  assert.equal(formatReportAxisValue(1_234_567), '1.23M');
  assert.equal(formatReportAxisValue(-2_000_000_000), '-2.00B');
});
