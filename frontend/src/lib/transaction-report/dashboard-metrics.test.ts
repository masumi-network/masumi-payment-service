import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectReportAssetUnits,
  formatReportAmount,
  formatReportCountValue,
  formatReportMetricValue,
  getEmptyReportAssetLabel,
  getReportTransactionCountDisplay,
  getReportAssetDescriptor,
  getReportMetricAmount,
  REPORT_METRICS,
  resolveReportAssetUnit,
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
    sellerPendingRevenue: emptyMetric(),
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
    { key: 'sellerPendingRevenue', label: 'Seller money not yet final' },
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

  // Stablecoins lead, so the report opens on a figure that reads as money.
  assert.deepEqual(collectReportAssetUnits(report), [
    'zz-usdm-wallet-unit',
    'usdcx-unit',
    'lovelace',
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
    value: '0.00',
    unitLabel: 'ADA',
    text: '0.00 ADA',
  });
  assert.deepEqual(formatReportAmount(undefined, usdm), {
    value: '0.00',
    unitLabel: 'USDM',
    text: '0.00 USDM',
  });
  assert.deepEqual(formatReportAmount(undefined, usdcx), {
    value: '0.00',
    unitLabel: 'USDCx',
    text: '0.00 USDCx',
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
    value: '-9,007,199,254,740,993.00',
    unitLabel: 'ADA',
    text: '-9,007,199,254,740,993.00 ADA',
  });
  assert.deepEqual(formatReportAmount(atomic), {
    value: '-9,007,199,254,740,993,000,001',
    unitLabel: 'policy.asset',
    text: '-9,007,199,254,740,993,000,001 policy.asset',
  });
});

test('a partial metric with no amount reads as unknown, never as a formatted zero', () => {
  const usdm = { unit: 'usdm-policy-unit', decimals: 6, symbol: 'USDM' } as const;

  assert.deepEqual(
    formatReportMetricValue({ amounts: [], completeness: 'partial' }, usdm.unit, usdm),
    {
      text: 'Not known',
      value: '0.00',
      unitLabel: 'USDM',
      isPartial: true,
      isUnknown: true,
      isNegative: false,
    },
  );
  assert.deepEqual(
    formatReportMetricValue({ amounts: [], completeness: 'complete' }, usdm.unit, usdm),
    {
      text: '0.00 USDM',
      value: '0.00',
      unitLabel: 'USDM',
      isPartial: false,
      isUnknown: false,
      isNegative: false,
    },
  );
});

test('a partial count still separates "none found" from "none exist"', () => {
  // The estimate dot carries completeness now, so the number itself stays clean.
  assert.equal(formatReportCountValue(12, 'partial'), '12');
  assert.equal(formatReportCountValue(12, 'complete'), '12');
  assert.deepEqual(getReportTransactionCountDisplay(0, 'partial', 'filtered transaction'), {
    text: '0 filtered transactions',
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

test('displayed amounts round to the cent without hiding a small nonzero figure', () => {
  const ada = { unit: 'lovelace', decimals: 6, symbol: 'ADA' } as const;
  const decimal = (decimalAmount: string, rawAmount: string) => ({
    ...amount('lovelace', rawAmount),
    decimalAmount,
    decimals: 6,
    symbol: 'ADA',
  });

  // Half-up, and a carry that widens the integer part.
  assert.equal(formatReportAmount(decimal('368.700000', '368700000'), ada).value, '368.70');
  assert.equal(formatReportAmount(decimal('1.005000', '1005000'), ada).value, '1.01');
  assert.equal(formatReportAmount(decimal('1.004999', '1004999'), ada).value, '1.00');
  assert.equal(formatReportAmount(decimal('9.999000', '9999000'), ada).value, '10.00');
  assert.equal(formatReportAmount(decimal('-1.005000', '-1005000'), ada).value, '-1.01');

  // A fee too small to show must not read as nothing.
  assert.equal(formatReportAmount(decimal('0.001234', '1234'), ada).text, '< 0.01 ADA');
  assert.equal(formatReportAmount(decimal('-0.001234', '-1234'), ada).text, '> -0.01 ADA');
  assert.equal(formatReportAmount(decimal('0.000000', '0'), ada).text, '0.00 ADA');

  // An asset with unknown decimals counts indivisible units, so it keeps none.
  assert.equal(formatReportAmount(amount('policy.asset', '4200001')).value, '4,200,001');
});
