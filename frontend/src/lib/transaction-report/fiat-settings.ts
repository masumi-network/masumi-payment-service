import type { GetReportsFacetsResponse, PostReportsSummaryData } from '@/lib/api/generated';

type ReportBody = PostReportsSummaryData['body'];
type ReportFiat = NonNullable<ReportBody['fiat']>;

export type ReportFiatCurrency = ReportFiat['currency'];
export type ReportFiatMode = NonNullable<ReportFiat['mode']>;
export type ReportFiatCapability = GetReportsFacetsResponse['data']['fiat'];

/** The value the form holds when no conversion is wanted. */
export const NO_FIAT_CURRENCY = 'none';

export type ReportFiatCurrencyChoice = ReportFiatCurrency | typeof NO_FIAT_CURRENCY;

export const REPORT_FIAT_CURRENCY_OPTIONS: ReadonlyArray<
  Readonly<{ value: ReportFiatCurrency; label: string; symbol: string }>
> = [
  { value: 'usd', label: 'US dollar', symbol: '$' },
  { value: 'eur', label: 'Euro', symbol: '€' },
  { value: 'gbp', label: 'British pound', symbol: '£' },
  { value: 'chf', label: 'Swiss franc', symbol: 'CHF' },
  { value: 'jpy', label: 'Japanese yen', symbol: '¥' },
  { value: 'aed', label: 'UAE dirham', symbol: 'AED' },
];

export const REPORT_FIAT_MODE_OPTIONS: ReadonlyArray<
  Readonly<{ value: ReportFiatMode; label: string; hint: string }>
> = [
  {
    value: 'PeriodAverage',
    label: 'One rate for the whole period',
    hint: 'Every request uses the average rate across the dates you picked. Steady figures, good for a period summary.',
  },
  {
    value: 'AccountingDate',
    label: 'The rate on each accounting date',
    hint: 'Every request uses the rate of the day it is booked on. Closer to how an accountant books each transaction.',
  },
  {
    value: 'TransactionTime',
    label: 'The rate at the time of each transaction',
    hint: 'Every request uses the price closest to the moment its transaction settled. CoinGecko sets how far apart its prices sit: minutes apart on a short report, up to an hour on a longer one.',
  },
];

/**
 * A converted figure travels as its own unit, next to lovelace and the tokens.
 *
 * That lets one asset picker offer both "ADA" and "every asset, converted to
 * EUR", because the conversion is just another unit the report can be read in.
 */
export const FIAT_UNIT_PREFIX = 'fiat:';

export function fiatUnitFor(currency: ReportFiatCurrency): string {
  return `${FIAT_UNIT_PREFIX}${currency}`;
}

/** The currency a unit converts to, or null when the unit is a real asset. */
export function fiatCurrencyFromUnit(unit: string): ReportFiatCurrency | null {
  if (!unit.startsWith(FIAT_UNIT_PREFIX)) return null;
  const currency = unit.slice(FIAT_UNIT_PREFIX.length);
  return isReportFiatCurrency(currency) ? currency : null;
}

export function isFiatUnit(unit: string): boolean {
  return fiatCurrencyFromUnit(unit) != null;
}

export function getFiatCurrencyLabel(currency: ReportFiatCurrency): string {
  const option = REPORT_FIAT_CURRENCY_OPTIONS.find((entry) => entry.value === currency);
  return option == null ? currency.toUpperCase() : `${currency.toUpperCase()} · ${option.label}`;
}

export function isReportFiatCurrency(value: string): value is ReportFiatCurrency {
  return REPORT_FIAT_CURRENCY_OPTIONS.some((option) => option.value === value);
}

/** Currencies this service can actually price, in the order the UI shows them. */
export function availableFiatCurrencies(
  capability: ReportFiatCapability | null,
): ReadonlyArray<Readonly<{ value: ReportFiatCurrency; label: string; symbol: string }>> {
  if (capability == null) return REPORT_FIAT_CURRENCY_OPTIONS;
  return REPORT_FIAT_CURRENCY_OPTIONS.filter((option) =>
    capability.currencies.includes(option.value),
  );
}

export type FiatIssue = Readonly<{ kind: 'setup' | 'range'; message: string }>;

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The reason a conversion cannot run yet, in words the operator can act on.
 *
 * A demo key answers 401 for older prices, which reads as a broken key rather
 * than a range that is out of reach, so the range is checked here first.
 */
export function getFiatIssue(
  capability: ReportFiatCapability | null,
  currency: ReportFiatCurrencyChoice,
  from: Date | null,
): FiatIssue | null {
  if (currency === NO_FIAT_CURRENCY || capability == null) return null;
  if (!capability.isConfigured) {
    return {
      kind: 'setup',
      message: `This service has no CoinGecko API key, so it cannot fetch exchange rates. ${capability.setupHint}`,
    };
  }
  const earliest = capability.earliestPriceableDate;
  if (earliest == null || from == null || from.getTime() >= new Date(earliest).getTime())
    return null;
  return {
    kind: 'range',
    message: `The free CoinGecko key only prices the last ${capability.historyDays ?? 365} days. Start the report on ${formatDay(
      new Date(earliest),
    )} or later, or switch the service to a paid CoinGecko key.`,
  };
}
