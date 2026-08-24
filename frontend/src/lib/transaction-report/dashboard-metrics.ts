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
  return `${count.toLocaleString()}${completeness === 'partial' ? ' observed' : ''}`;
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

const REPORT_ASSET_SYMBOL_ORDER = ['ADA', 'USDM', 'USDCx'] as const;

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
): string | null {
  return assetUnits.includes(requestedUnit) ? requestedUnit : (assetUnits[0] ?? null);
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
  const exactValue =
    amount?.decimalAmount ??
    amount?.rawAmount ??
    (fallbackDescriptor.decimals == null
      ? '0'
      : fallbackDescriptor.decimals === 0
        ? '0'
        : `0.${'0'.repeat(fallbackDescriptor.decimals)}`);
  const value = groupReportAmount(exactValue);
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
  isPartial: boolean;
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
  return {
    text: isPartial && amount == null ? `${display.text} observed` : display.text,
    isPartial,
    isNegative: BigInt(amount?.rawAmount ?? '0') < BigInt(0),
  };
}

export type ReportChartDimensions = Readonly<{
  width: number;
  height: number;
  padding?: number;
}>;

export type ReportChartDomain = Readonly<{
  min: bigint;
  max: bigint;
}>;

export type ReportChartPoint = Readonly<{
  x: number;
  y: number;
  bucketStart: Date;
  bucketEnd: Date;
  rawAmount: string;
  valueText: string;
  completeness: ReportMetric['completeness'];
  isUnknown?: true;
}>;

export type ReportChartCoordinate = Readonly<{
  x: number;
  y: number;
  isUnknown?: boolean;
}>;

export const DEFAULT_REPORT_CHART_DIMENSIONS = {
  width: 640,
  height: 240,
  padding: 16,
} as const satisfies ReportChartDimensions;

const MAX_CHART_DIMENSION = 4_096;
const CHART_COORDINATE_SCALE = 1_000_000;

function normalizeChartDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, MAX_CHART_DIMENSION);
}

function normalizeChartPadding(value: number | undefined, width: number, height: number): number {
  const maxPadding = Math.min(width, height) / 2;
  const defaultPadding = DEFAULT_REPORT_CHART_DIMENSIONS.padding;
  if (value == null) return Math.min(defaultPadding, maxPadding);
  if (!Number.isFinite(value)) return Math.min(defaultPadding, maxPadding);
  return Math.min(Math.max(value, 0), maxPadding);
}

function rawMetricValue(metrics: ReportMetrics, metricKey: ReportMetricKey, unit: string): bigint {
  return BigInt(getReportMetricAmount(metrics, metricKey, unit)?.rawAmount ?? '0');
}

function domainIncludingZero(
  values: readonly bigint[],
  requestedDomain?: ReportChartDomain,
): ReportChartDomain {
  let min = BigInt(0);
  let max = BigInt(0);
  const candidates = requestedDomain
    ? [requestedDomain.min, requestedDomain.max, ...values]
    : values;
  for (const value of candidates) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

export function getReportChartDomain(
  history: ReportHistory,
  metricKeys: readonly ReportMetricKey[],
  unit: string,
): ReportChartDomain {
  const values = history.flatMap((bucket) =>
    metricKeys.map((metricKey) => rawMetricValue(bucket.metrics, metricKey, unit)),
  );
  return domainIncludingZero(values);
}

export function scaleReportChartY(
  value: bigint,
  domain: ReportChartDomain,
  dimensions: ReportChartDimensions = DEFAULT_REPORT_CHART_DIMENSIONS,
): number {
  const width = normalizeChartDimension(dimensions.width, DEFAULT_REPORT_CHART_DIMENSIONS.width);
  const height = normalizeChartDimension(dimensions.height, DEFAULT_REPORT_CHART_DIMENSIONS.height);
  const padding = normalizeChartPadding(dimensions.padding, width, height);
  const drawableHeight = height - padding * 2;
  const chartDomain = domainIncludingZero([value], domain);
  const range = chartDomain.max - chartDomain.min;
  if (range === BigInt(0)) return height / 2;

  const drawableHeightScaled = BigInt(Math.round(drawableHeight * CHART_COORDINATE_SCALE));
  return (
    padding +
    Number(((chartDomain.max - value) * drawableHeightScaled) / range) / CHART_COORDINATE_SCALE
  );
}

export function buildReportChartPoints(
  history: ReportHistory,
  metricKey: ReportMetricKey,
  unit: string,
  dimensions: ReportChartDimensions = DEFAULT_REPORT_CHART_DIMENSIONS,
  domain?: ReportChartDomain,
  descriptor?: ReportAssetDescriptor,
): ReportChartPoint[] {
  if (history.length === 0) return [];

  const width = normalizeChartDimension(dimensions.width, DEFAULT_REPORT_CHART_DIMENSIONS.width);
  const height = normalizeChartDimension(dimensions.height, DEFAULT_REPORT_CHART_DIMENSIONS.height);
  const padding = normalizeChartPadding(dimensions.padding, width, height);
  const drawableWidth = width - padding * 2;
  const amounts = history.map((bucket) => getReportMetricAmount(bucket.metrics, metricKey, unit));
  const values = amounts.map((amount) => BigInt(amount?.rawAmount ?? '0'));
  const descriptorAmount =
    amounts.find((amount) => amount?.symbol != null || amount?.decimals != null) ??
    amounts.find((amount) => amount != null);
  const seriesDescriptor =
    descriptor ??
    (descriptorAmount == null
      ? getKnownAssetDescriptor(unit)
      : descriptorFromAmount(descriptorAmount));
  const chartDomain = domainIncludingZero(values, domain);

  return history.map((bucket, index) => {
    const metric = bucket.metrics[metricKey];
    const amount = amounts[index];
    const isUnknown = metric.completeness === 'partial' && amount == null;
    const y = scaleReportChartY(values[index], chartDomain, dimensions);
    return {
      x:
        history.length === 1 ? width / 2 : padding + (drawableWidth * index) / (history.length - 1),
      y,
      bucketStart: bucket.bucketStart,
      bucketEnd: bucket.bucketEnd,
      rawAmount: amount?.rawAmount ?? '0',
      valueText: formatReportMetricValue(metric, unit, seriesDescriptor).text,
      completeness: metric.completeness,
      ...(isUnknown ? { isUnknown: true as const } : {}),
    };
  });
}

export function buildReportLinePath(points: readonly ReportChartCoordinate[]): string {
  const commands: string[] = [];
  let hasOpenLine = false;
  for (const point of points) {
    if (point.isUnknown) {
      hasOpenLine = false;
      continue;
    }
    commands.push(`${hasOpenLine ? 'L' : 'M'} ${point.x} ${point.y}`);
    hasOpenLine = true;
  }
  return commands.join(' ');
}
