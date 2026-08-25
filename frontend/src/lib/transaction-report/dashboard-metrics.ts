import type { PostReportsSummaryResponses } from '@/lib/api/generated';

export type ReportSummary = PostReportsSummaryResponses[200]['data'];
export type ReportMetrics = ReportSummary['totals'];
export type ReportMetricKey = Exclude<
  keyof ReportMetrics,
  'transactionCount' | 'transactionCountCompleteness'
>;
export type ReportMetric = ReportMetrics[ReportMetricKey];
export type ReportAmount = ReportMetric['amounts'][number];
export type ReportHistory = ReportSummary['history'];

export type ReportTransactionCountDisplay = Readonly<{
  text: string;
  isConfirmedEmpty: boolean;
}>;

export function formatReportCountValue(
  count: number,
  completeness: ReportMetrics['transactionCountCompleteness'],
): string {
  // Completeness is shown by the estimate dot next to the value, not by a
  // word glued onto the number.
  void completeness;
  return count.toLocaleString();
}

export function getReportTransactionCountDisplay(
  count: number,
  completeness: ReportMetrics['transactionCountCompleteness'],
  singularLabel: string,
): ReportTransactionCountDisplay {
  const label = count === 1 ? singularLabel : `${singularLabel}s`;
  return {
    text: `${formatReportCountValue(count, completeness)} ${label}`,
    isConfirmedEmpty: count === 0 && completeness === 'complete',
  };
}

export const REPORT_METRICS = [
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
] as const satisfies ReadonlyArray<Readonly<{ key: ReportMetricKey; label: string }>>;

const REPORT_ASSET_METRIC_KEYS = [
  'sellerGrossRevenue',
  'protocolFees',
  'sellerNetRevenue',
  'buyerGrossSpend',
  'returnedFunds',
  'buyerNetSpend',
] as const satisfies ReadonlyArray<ReportMetricKey>;

/**
 * Stablecoins come first, so the report opens on a figure an operator can read
 * as money. An ADA total moves with the ADA price and needs a second step
 * before it means anything.
 */
const REPORT_ASSET_SYMBOL_ORDER = ['USDM', 'USDCx', 'ADA'] as const;

export type ReportAssetDescriptor = Readonly<{
  unit: string;
  decimals: number | null;
  symbol: string | null;
}>;

function addMetricUnits(metrics: ReportMetrics, units: Set<string>): void {
  for (const key of REPORT_ASSET_METRIC_KEYS) {
    for (const amount of metrics[key].amounts) units.add(amount.unit);
  }
}

function getReportMetricSurfaces(summary: ReportSummary): ReportMetrics[] {
  return [
    summary.totals,
    ...summary.history.map((bucket) => bucket.metrics),
    ...summary.wallets.map((wallet) => wallet.metrics),
  ];
}

export function collectReportAssetUnits(summary: ReportSummary): string[] {
  const units = new Set<string>();
  for (const metrics of getReportMetricSurfaces(summary)) addMetricUnits(metrics, units);
  return [...units].sort((left, right) => {
    const leftSymbol = getReportAssetDescriptor(summary, left).symbol;
    const rightSymbol = getReportAssetDescriptor(summary, right).symbol;
    const leftRank = REPORT_ASSET_SYMBOL_ORDER.findIndex((symbol) => symbol === leftSymbol);
    const rightRank = REPORT_ASSET_SYMBOL_ORDER.findIndex((symbol) => symbol === rightSymbol);
    const normalizedLeftRank = leftRank === -1 ? REPORT_ASSET_SYMBOL_ORDER.length : leftRank;
    const normalizedRightRank = rightRank === -1 ? REPORT_ASSET_SYMBOL_ORDER.length : rightRank;
    if (normalizedLeftRank !== normalizedRightRank) {
      return normalizedLeftRank - normalizedRightRank;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function resolveReportAssetUnit(
  assetUnits: readonly string[],
  requestedUnit: string,
  /**
   * Where to land when the asked-for unit is gone. Turning a conversion on
   * should show the converted figures, not leave the reader on ADA wondering
   * what the setting did.
   */
  preferredUnit?: string | null,
): string | null {
  if (assetUnits.includes(requestedUnit)) return requestedUnit;
  if (preferredUnit != null && assetUnits.includes(preferredUnit)) return preferredUnit;
  return assetUnits[0] ?? null;
}

export function getEmptyReportAssetLabel(
  completeness: ReportMetric['completeness'],
): 'Not determined' | 'No asset activity' {
  return completeness === 'partial' ? 'Not determined' : 'No asset activity';
}

function descriptorFromAmount(amount: ReportAmount): ReportAssetDescriptor {
  return {
    unit: amount.unit,
    decimals: amount.decimals,
    symbol: amount.symbol?.trim() || null,
  };
}

function getKnownAssetDescriptor(unit: string): ReportAssetDescriptor {
  if (unit.toLowerCase() === 'lovelace') {
    return { unit: 'lovelace', decimals: 6, symbol: 'ADA' };
  }
  return { unit, decimals: null, symbol: null };
}

function findMetricAmount(metrics: ReportMetrics, unit: string): ReportAmount | undefined {
  for (const { key } of REPORT_METRICS) {
    const amount = getReportMetricAmount(metrics, key, unit);
    if (amount != null) return amount;
  }
  return undefined;
}

export function getReportAssetDescriptor(
  summary: ReportSummary,
  unit: string,
): ReportAssetDescriptor {
  const knownDescriptor = getKnownAssetDescriptor(unit);
  if (knownDescriptor.symbol != null) return knownDescriptor;

  for (const metrics of getReportMetricSurfaces(summary)) {
    const amount = findMetricAmount(metrics, unit);
    if (amount != null) return descriptorFromAmount(amount);
  }
  return knownDescriptor;
}

export function getReportMetricAmount(
  metrics: ReportMetrics,
  metricKey: ReportMetricKey,
  unit: string,
): ReportAmount | undefined {
  return metrics[metricKey].amounts.find((amount) => amount.unit === unit);
}

export type ReportAmountDisplay = Readonly<{
  value: string;
  unitLabel: string;
  text: string;
}>;

export type ReportAmountFallback = string | ReportAssetDescriptor;

/** Operators read money to the cent. The exports keep the full precision. */
export const REPORT_DISPLAY_DECIMALS = 2;

/** The smallest amount two decimals can show. */
const REPORT_SMALLEST_DISPLAYED = '0.01';

/**
 * Rounds a decimal string half-up. String maths, because a lovelace total can
 * exceed what a double holds exactly.
 */
function roundDecimalString(value: string, decimals: number): string {
  const parts = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(value);
  if (parts == null) return value;
  const [, sign, integer, fraction = ''] = parts;
  if (fraction.length <= decimals) {
    return decimals === 0
      ? `${sign}${integer}`
      : `${sign}${integer}.${fraction.padEnd(decimals, '0')}`;
  }
  const carries = fraction.charCodeAt(decimals) - 48 >= 5;
  const kept = `${integer}${fraction.slice(0, decimals)}`;
  const rounded = (carries ? BigInt(kept) + BigInt(1) : BigInt(kept))
    .toString()
    .padStart(decimals + 1, '0');
  const boundary = rounded.length - decimals;
  return decimals === 0
    ? `${sign}${rounded}`
    : `${sign}${rounded.slice(0, boundary)}.${rounded.slice(boundary)}`;
}

function isZeroDecimalString(value: string): boolean {
  return /^[+-]?0*(?:\.0*)?$/.test(value);
}

function groupReportAmount(value: string): string {
  const parts = /^([+-]?)(\d+)(\.\d+)?$/.exec(value);
  if (parts == null) return value;
  const [, sign, integer, fraction = ''] = parts;
  const groupedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${groupedInteger}${fraction}`;
}

export function formatReportAmount(
  amount: ReportAmount | undefined,
  fallback: ReportAmountFallback = '',
): ReportAmountDisplay {
  const fallbackDescriptor =
    typeof fallback === 'string' ? getKnownAssetDescriptor(fallback) : fallback;
  const fallbackValue =
    fallbackDescriptor.decimals == null || fallbackDescriptor.decimals === 0
      ? '0'
      : `0.${'0'.repeat(fallbackDescriptor.decimals)}`;
  const exactValue = amount?.decimalAmount ?? amount?.rawAmount ?? fallbackValue;
  // An atomic amount of an asset whose decimals we do not know is a whole
  // count of indivisible units. Giving it a fractional part would invent one.
  const hasFractionalUnits =
    amount == null
      ? fallbackDescriptor.decimals != null && fallbackDescriptor.decimals > 0
      : amount.decimalAmount != null;
  const roundedValue = hasFractionalUnits
    ? roundDecimalString(exactValue, REPORT_DISPLAY_DECIMALS)
    : exactValue;
  // Rounding a small nonzero amount to 0.00 would state that nothing moved.
  const value =
    isZeroDecimalString(roundedValue) && !isZeroDecimalString(exactValue)
      ? `${exactValue.startsWith('-') ? '> -' : '< '}${REPORT_SMALLEST_DISPLAYED}`
      : groupReportAmount(roundedValue);
  const unitLabel =
    amount?.symbol?.trim() ||
    amount?.unit ||
    fallbackDescriptor.symbol?.trim() ||
    fallbackDescriptor.unit;
  return {
    value,
    unitLabel,
    text: unitLabel ? `${value} ${unitLabel}` : value,
  };
}

export type ReportMetricValueDisplay = Readonly<{
  text: string;
  /** The grouped number on its own, so a caller can size it apart from its unit. */
  value: string;
  unitLabel: string;
  isPartial: boolean;
  /** The report could not read this figure. `text` says so; `value` is not a total. */
  isUnknown: boolean;
  isNegative: boolean;
}>;

export function formatReportMetricValue(
  metric: ReportMetric,
  unit: string,
  fallback: ReportAmountFallback = unit,
): ReportMetricValueDisplay {
  const amount = metric.amounts.find((candidate) => candidate.unit === unit);
  const display = formatReportAmount(amount, fallback);
  const isPartial = metric.completeness === 'partial';
  // A partial metric with no amount in this unit is unknown, not zero. Printing
  // a formatted zero would state a total the report never read.
  const isUnknown = isPartial && amount == null;
  return {
    text: isUnknown ? 'Not known' : display.text,
    value: display.value,
    unitLabel: display.unitLabel,
    isPartial,
    isUnknown,
    isNegative: BigInt(amount?.rawAmount ?? '0') < BigInt(0),
  };
}
