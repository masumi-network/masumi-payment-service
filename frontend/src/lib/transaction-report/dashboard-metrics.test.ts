import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReportChartPoints,
  buildReportLinePath,
  collectReportAssetUnits,
  formatReportAmount,
  formatReportCountValue,
  formatReportMetricValue,
  getEmptyReportAssetLabel,
  getReportTransactionCountDisplay,
  getReportAssetDescriptor,
  getReportChartDomain,
  getReportMetricAmount,
  REPORT_METRICS,
  resolveReportAssetUnit,
  scaleReportChartY,
  type ReportAmount,
  type ReportMetrics,
  type ReportSummary,
} from './dashboard-metrics';

function amount(unit: string, rawAmount = '0'): ReportAmount {
  return {
    unit,
    rawAmount,
    decimalAmount: null,
    decimals: null,
    symbol: null,
  };
}

function knownAmount(
  unit: string,
  symbol: 'ADA' | 'USDM' | 'USDCx',
  rawAmount = '0',
): ReportAmount {
  return {
    ...amount(unit, rawAmount),
    decimalAmount: `${rawAmount}.000000`,
    decimals: 6,
    symbol,
  };
}

function metrics(overrides: Partial<ReportMetrics> = {}): ReportMetrics {
  const emptyMetric = () => ({ amounts: [], completeness: 'complete' as const });
  return {
    transactionCount: 0,
    transactionCountCompleteness: 'complete',
    sellerGrossRevenue: emptyMetric(),
    protocolFees: emptyMetric(),
    sellerCardanoFees: emptyMetric(),
    sellerNetRevenue: emptyMetric(),
    buyerGrossSpend: emptyMetric(),
    returnedFunds: emptyMetric(),
    buyerCardanoFees: emptyMetric(),
    buyerNetSpend: emptyMetric(),
    actorCardanoFees: emptyMetric(),
    adminCardanoFees: emptyMetric(),
    totalCardanoFees: emptyMetric(),
    ...overrides,
  };
}

function summary(
  totals: ReportMetrics,
  history: ReportSummary['history'] = [],
  wallets: ReportSummary['wallets'] = [],
): ReportSummary {
  return { totals, history, wallets } as ReportSummary;
}

test('exposes every financial report metric with an operator-facing label', () => {
  assert.deepEqual(REPORT_METRICS, [
    { key: 'sellerGrossRevenue', label: 'Seller gross revenue' },
    { key: 'protocolFees', label: 'Protocol fees' },
    { key: 'sellerCardanoFees', label: 'Seller Cardano fees' },
    { key: 'sellerNetRevenue', label: 'Seller net revenue' },
    { key: 'buyerGrossSpend', label: 'Buyer gross spend' },
    { key: 'returnedFunds', label: 'Returned funds' },
    { key: 'buyerCardanoFees', label: 'Buyer Cardano fees' },
    { key: 'buyerNetSpend', label: 'Buyer net spend' },
    { key: 'actorCardanoFees', label: 'Reconciled actor fees' },
    { key: 'adminCardanoFees', label: 'Admin Cardano fees' },
    { key: 'totalCardanoFees', label: 'Total Cardano fees' },
  ]);
});

test('collects and orders business asset units without Cardano fee-only units', () => {
  const report = summary(
    metrics({
      sellerGrossRevenue: {
        amounts: [amount('unit-z'), knownAmount('usdcx-unit', 'USDCx')],
        completeness: 'complete',
      },
      sellerCardanoFees: {
        amounts: [amount('seller-fee-only-unit')],
        completeness: 'complete',
      },
    }),
    [
      {
        bucketStart: new Date('2026-01-01T00:00:00.000Z'),
        bucketEnd: new Date('2026-01-02T00:00:00.000Z'),
        metrics: metrics({
          protocolFees: {
            amounts: [amount('unit-a')],
            completeness: 'complete',
          },
          buyerGrossSpend: {
            amounts: [knownAmount('lovelace', 'ADA')],
            completeness: 'complete',
          },
          totalCardanoFees: {
            amounts: [amount('total-fee-only-unit')],
            completeness: 'complete',
          },
        }),
      },
    ],
    [
      {
        managedWallet: null,
        role: 'Seller',
        metrics: metrics({
          sellerNetRevenue: {
            amounts: [knownAmount('zz-usdm-wallet-unit', 'USDM')],
            completeness: 'complete',
          },
        }),
      },
    ],
  );

  assert.deepEqual(collectReportAssetUnits(report), [
    'lovelace',
    'zz-usdm-wallet-unit',
    'usdcx-unit',
    'unit-a',
    'unit-z',
  ]);
});

test('uses summary asset metadata to format exact zeros for empty metrics', () => {
  const report = summary(
    metrics({
      sellerGrossRevenue: {
        amounts: [knownAmount('usdm-policy-unit', 'USDM')],
        completeness: 'complete',
      },
      buyerGrossSpend: {
        amounts: [knownAmount('usdcx-policy-unit', 'USDCx')],
        completeness: 'complete',
      },
    }),
  );

  const ada = getReportAssetDescriptor(report, 'lovelace');
  const usdm = getReportAssetDescriptor(report, 'usdm-policy-unit');
  const usdcx = getReportAssetDescriptor(report, 'usdcx-policy-unit');

  assert.deepEqual(formatReportAmount(undefined, ada), {
    value: '0.000000',
    unitLabel: 'ADA',
    text: '0.000000 ADA',
  });
  assert.deepEqual(formatReportAmount(undefined, usdm), {
    value: '0.000000',
    unitLabel: 'USDM',
    text: '0.000000 USDM',
  });
  assert.deepEqual(formatReportAmount(undefined, usdcx), {
    value: '0.000000',
    unitLabel: 'USDCx',
    text: '0.000000 USDCx',
  });
});

test('formats exact decimal and atomic amount strings without losing negative signs', () => {
  const decimal = {
    ...amount('lovelace', '-9007199254740993000001'),
    decimalAmount: '-9007199254740993.000001',
    decimals: 6,
    symbol: 'ADA',
  };
  const atomic = amount('policy.asset', '-9007199254740993000001');

  assert.deepEqual(formatReportAmount(decimal), {
    value: '-9,007,199,254,740,993.000001',
    unitLabel: 'ADA',
    text: '-9,007,199,254,740,993.000001 ADA',
  });
  assert.deepEqual(formatReportAmount(atomic), {
    value: '-9,007,199,254,740,993,000,001',
    unitLabel: 'policy.asset',
    text: '-9,007,199,254,740,993,000,001 policy.asset',
  });
});

test('partial empty metrics preserve exact units and label the zero as observed', () => {
  const usdm = { unit: 'usdm-policy-unit', decimals: 6, symbol: 'USDM' } as const;

  assert.deepEqual(
    formatReportMetricValue({ amounts: [], completeness: 'partial' }, usdm.unit, usdm),
    {
      text: '0.000000 USDM observed',
      isPartial: true,
      isNegative: false,
    },
  );
  assert.deepEqual(
    formatReportMetricValue({ amounts: [], completeness: 'complete' }, usdm.unit, usdm),
    {
      text: '0.000000 USDM',
      isPartial: false,
      isNegative: false,
    },
  );
});

test('partial zero transaction counts remain observed values instead of confirmed empty reports', () => {
  assert.equal(formatReportCountValue(12, 'partial'), '12 observed');
  assert.equal(formatReportCountValue(12, 'complete'), '12');
  assert.deepEqual(getReportTransactionCountDisplay(0, 'partial', 'filtered transaction'), {
    text: '0 observed filtered transactions',
    isConfirmedEmpty: false,
  });
  assert.deepEqual(getReportTransactionCountDisplay(0, 'complete', 'distinct logical payment'), {
    text: '0 distinct logical payments',
    isConfirmedEmpty: true,
  });
});

test('empty asset labels and reset selection do not present partial data as no activity', () => {
  assert.equal(getEmptyReportAssetLabel('partial'), 'Not determined');
  assert.equal(getEmptyReportAssetLabel('complete'), 'No asset activity');
  assert.equal(resolveReportAssetUnit(['lovelace', 'unit-a'], 'unit-a'), 'unit-a');
  assert.equal(resolveReportAssetUnit(['lovelace', 'unit-a'], ''), 'lovelace');
  assert.equal(resolveReportAssetUnit([], 'unit-a'), null);
});

test('finds an exact metric amount and formats a missing unit as zero', () => {
  const totals = metrics({
    buyerNetSpend: {
      amounts: [amount('unit-a', '42')],
      completeness: 'complete',
    },
  });

  assert.equal(getReportMetricAmount(totals, 'buyerNetSpend', 'unit-a')?.rawAmount, '42');
  assert.equal(getReportMetricAmount(totals, 'buyerNetSpend', 'unit-b'), undefined);
  assert.deepEqual(formatReportAmount(undefined, 'unit-b'), {
    value: '0',
    unitLabel: 'unit-b',
    text: '0 unit-b',
  });
});

test('returns no SVG points for empty report history', () => {
  assert.deepEqual(
    buildReportChartPoints([], 'sellerNetRevenue', 'lovelace', {
      width: 100,
      height: 100,
      padding: 10,
    }),
    [],
  );
});

test('plots one negative chart point from a zero baseline and keeps its accessible data', () => {
  const bucketStart = new Date('2026-01-01T00:00:00.000Z');
  const bucketEnd = new Date('2026-01-02T00:00:00.000Z');
  const history: ReportSummary['history'] = [
    {
      bucketStart,
      bucketEnd,
      metrics: metrics({
        sellerNetRevenue: {
          amounts: [
            {
              ...amount('lovelace', '-9007199254740993000001'),
              decimalAmount: '-9007199254740993.000001',
              decimals: 6,
              symbol: 'ADA',
            },
          ],
          completeness: 'partial',
        },
      }),
    },
  ];

  assert.deepEqual(
    buildReportChartPoints(history, 'sellerNetRevenue', 'lovelace', {
      width: 100,
      height: 80,
      padding: 10,
    }),
    [
      {
        x: 50,
        y: 70,
        bucketStart,
        bucketEnd,
        rawAmount: '-9007199254740993000001',
        valueText: '-9,007,199,254,740,993.000001 ADA',
        completeness: 'partial',
      },
    ],
  );
});

test('spreads an all-equal positive series across the zero-based plot', () => {
  const history: ReportSummary['history'] = [0, 1, 2].map((day) => ({
    bucketStart: new Date(Date.UTC(2026, 0, day + 1)),
    bucketEnd: new Date(Date.UTC(2026, 0, day + 2)),
    metrics: metrics({
      buyerGrossSpend: {
        amounts: [amount('unit-a', '7')],
        completeness: 'complete',
      },
    }),
  }));

  const points = buildReportChartPoints(history, 'buyerGrossSpend', 'unit-a', {
    width: 100,
    height: 80,
    padding: 10,
  });

  assert.deepEqual(
    points.map(({ x, y }) => ({ x, y })),
    [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 90, y: 10 },
    ],
  );
});

test('formats a missing stablecoin chart bucket with metadata from its series', () => {
  const history: ReportSummary['history'] = [
    {
      bucketStart: new Date('2026-01-01T00:00:00.000Z'),
      bucketEnd: new Date('2026-01-02T00:00:00.000Z'),
      metrics: metrics({
        protocolFees: {
          amounts: [],
          completeness: 'complete',
        },
      }),
    },
    {
      bucketStart: new Date('2026-01-02T00:00:00.000Z'),
      bucketEnd: new Date('2026-01-03T00:00:00.000Z'),
      metrics: metrics({
        protocolFees: {
          amounts: [
            {
              ...knownAmount('usdm-policy-unit', 'USDM', '1000000'),
              decimalAmount: '1.000000',
            },
          ],
          completeness: 'complete',
        },
      }),
    },
  ];

  const points = buildReportChartPoints(history, 'protocolFees', 'usdm-policy-unit', {
    width: 100,
    height: 100,
    padding: 10,
  });

  assert.deepEqual(
    points.map(({ rawAmount, valueText }) => ({ rawAmount, valueText })),
    [
      { rawAmount: '0', valueText: '0.000000 USDM' },
      { rawAmount: '1000000', valueText: '1.000000 USDM' },
    ],
  );
});

test('uses an explicit descriptor when every stablecoin chart bucket is empty', () => {
  const history: ReportSummary['history'] = [0, 1].map((day) => ({
    bucketStart: new Date(Date.UTC(2026, 0, day + 1)),
    bucketEnd: new Date(Date.UTC(2026, 0, day + 2)),
    metrics: metrics({
      returnedFunds: {
        amounts: [],
        completeness: 'complete',
      },
    }),
  }));

  const points = buildReportChartPoints(
    history,
    'returnedFunds',
    'usdcx-policy-unit',
    { width: 100, height: 80, padding: 10 },
    undefined,
    { unit: 'usdcx-policy-unit', decimals: 6, symbol: 'USDCx' },
  );

  assert.deepEqual(
    points.map(({ rawAmount, valueText }) => ({ rawAmount, valueText })),
    [
      { rawAmount: '0', valueText: '0.000000 USDCx' },
      { rawAmount: '0', valueText: '0.000000 USDCx' },
    ],
  );
});

test('scales negative and positive atomic amounts around zero without changing their strings', () => {
  const history: ReportSummary['history'] = ['-10', '0', '10'].map((rawAmount, index) => ({
    bucketStart: new Date(Date.UTC(2026, 0, index + 1)),
    bucketEnd: new Date(Date.UTC(2026, 0, index + 2)),
    metrics: metrics({
      sellerNetRevenue: {
        amounts: [amount('unit-a', rawAmount)],
        completeness: 'complete',
      },
    }),
  }));

  const points = buildReportChartPoints(history, 'sellerNetRevenue', 'unit-a', {
    width: 100,
    height: 100,
    padding: 10,
  });

  assert.deepEqual(
    points.map(({ y, rawAmount, valueText }) => ({ y, rawAmount, valueText })),
    [
      { y: 90, rawAmount: '-10', valueText: '-10 unit-a' },
      { y: 50, rawAmount: '0', valueText: '0 unit-a' },
      { y: 10, rawAmount: '10', valueText: '10 unit-a' },
    ],
  );
});

test('scales signed amounts above Number safe range with BigInt precision', () => {
  const rawAmounts = ['-9007199254740993000002', '0', '9007199254740993000002'];
  const history: ReportSummary['history'] = rawAmounts.map((rawAmount, index) => ({
    bucketStart: new Date(Date.UTC(2026, 0, index + 1)),
    bucketEnd: new Date(Date.UTC(2026, 0, index + 2)),
    metrics: metrics({
      totalCardanoFees: {
        amounts: [amount('lovelace', rawAmount)],
        completeness: 'complete',
      },
    }),
  }));

  const points = buildReportChartPoints(history, 'totalCardanoFees', 'lovelace', {
    width: 100,
    height: 100,
    padding: 10,
  });

  assert.deepEqual(
    points.map(({ y, rawAmount }) => ({ y, rawAmount })),
    [
      { y: 90, rawAmount: rawAmounts[0] },
      { y: 50, rawAmount: rawAmounts[1] },
      { y: 10, rawAmount: rawAmounts[2] },
    ],
  );
  assert.ok(points.every(({ x, y }) => x >= 0 && x <= 100 && y >= 0 && y <= 100));
});

test('builds a zero-inclusive domain for shared formula-series scaling', () => {
  const history: ReportSummary['history'] = [
    {
      bucketStart: new Date('2026-01-01T00:00:00.000Z'),
      bucketEnd: new Date('2026-01-02T00:00:00.000Z'),
      metrics: metrics({
        sellerNetRevenue: {
          amounts: [amount('unit-a', '-10')],
          completeness: 'complete',
        },
        protocolFees: {
          amounts: [amount('unit-a', '0')],
          completeness: 'complete',
        },
      }),
    },
    {
      bucketStart: new Date('2026-01-02T00:00:00.000Z'),
      bucketEnd: new Date('2026-01-03T00:00:00.000Z'),
      metrics: metrics({
        sellerNetRevenue: {
          amounts: [amount('unit-a', '10')],
          completeness: 'complete',
        },
        protocolFees: {
          amounts: [amount('unit-a', '100')],
          completeness: 'complete',
        },
      }),
    },
  ];
  const domain = getReportChartDomain(history, ['sellerNetRevenue', 'protocolFees'], 'unit-a');
  const dimensions = { width: 100, height: 100, padding: 10 };
  const sellerPoints = buildReportChartPoints(
    history,
    'sellerNetRevenue',
    'unit-a',
    dimensions,
    domain,
  );
  const feePoints = buildReportChartPoints(history, 'protocolFees', 'unit-a', dimensions, domain);

  assert.deepEqual(domain, { min: BigInt(-10), max: BigInt(100) });
  assert.equal(sellerPoints[0].y, 90);
  assert.equal(feePoints[1].y, 10);
  assert.equal(feePoints[0].y, 82.727272);
});

test('places and preserves the visible zero baseline for signed chart domains', () => {
  const dimensions = { width: 100, height: 100, padding: 10 };

  assert.equal(scaleReportChartY(BigInt(0), { min: BigInt(-10), max: BigInt(10) }, dimensions), 50);
  assert.equal(scaleReportChartY(BigInt(0), { min: BigInt(0), max: BigInt(10) }, dimensions), 90);
});

test('uses a centered all-zero fallback domain for empty and zero history', () => {
  assert.deepEqual(getReportChartDomain([], ['buyerNetSpend'], 'unit-a'), {
    min: BigInt(0),
    max: BigInt(0),
  });

  const history: ReportSummary['history'] = [
    {
      bucketStart: new Date('2026-01-01T00:00:00.000Z'),
      bucketEnd: new Date('2026-01-02T00:00:00.000Z'),
      metrics: metrics({
        buyerNetSpend: {
          amounts: [amount('unit-a', '0')],
          completeness: 'complete',
        },
      }),
    },
  ];

  assert.deepEqual(getReportChartDomain(history, ['buyerNetSpend'], 'unit-a'), {
    min: BigInt(0),
    max: BigInt(0),
  });
  assert.equal(
    buildReportChartPoints(history, 'buyerNetSpend', 'unit-a', {
      width: 100,
      height: 80,
      padding: 10,
    })[0].y,
    40,
  );
});

test('uses bounded default SVG dimensions when dimensions are omitted', () => {
  const history: ReportSummary['history'] = [
    {
      bucketStart: new Date('2026-01-01T00:00:00.000Z'),
      bucketEnd: new Date('2026-01-02T00:00:00.000Z'),
      metrics: metrics({
        returnedFunds: {
          amounts: [amount('unit-a', '1')],
          completeness: 'complete',
        },
      }),
    },
  ];

  const [point] = buildReportChartPoints(history, 'returnedFunds', 'unit-a');

  assert.deepEqual({ x: point.x, y: point.y }, { x: 320, y: 16 });
});

test('builds an SVG line path from bounded chart points', () => {
  assert.equal(buildReportLinePath([]), '');
  assert.equal(
    buildReportLinePath([
      { x: 10, y: 90 },
      { x: 50.25, y: 40.5 },
      { x: 90, y: 10 },
    ]),
    'M 10 90 L 50.25 40.5 L 90 10',
  );
});

test('breaks chart lines across partial buckets with no observed amount', () => {
  const history: ReportSummary['history'] = [
    {
      bucketStart: new Date('2026-01-01T00:00:00.000Z'),
      bucketEnd: new Date('2026-01-02T00:00:00.000Z'),
      metrics: metrics({
        sellerNetRevenue: {
          amounts: [amount('unit-a', '10')],
          completeness: 'complete',
        },
      }),
    },
    {
      bucketStart: new Date('2026-01-02T00:00:00.000Z'),
      bucketEnd: new Date('2026-01-03T00:00:00.000Z'),
      metrics: metrics({
        sellerNetRevenue: { amounts: [], completeness: 'partial' },
      }),
    },
    {
      bucketStart: new Date('2026-01-03T00:00:00.000Z'),
      bucketEnd: new Date('2026-01-04T00:00:00.000Z'),
      metrics: metrics({
        sellerNetRevenue: {
          amounts: [amount('unit-a', '20')],
          completeness: 'complete',
        },
      }),
    },
  ];

  const points = buildReportChartPoints(history, 'sellerNetRevenue', 'unit-a', {
    width: 100,
    height: 100,
    padding: 10,
  });

  assert.equal(points[1].isUnknown, true);
  assert.equal(points[1].valueText, '0 unit-a observed');
  assert.equal(buildReportLinePath(points), 'M 10 50 M 90 10');
});
