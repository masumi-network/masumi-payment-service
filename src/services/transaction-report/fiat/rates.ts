/**
 * Fiat rates for a report, as data.
 *
 * Rates are looked up on UTC days, because a price series is global while a
 * report's buckets follow the operator's own time zone. The mismatch is at
 * most a few hours of price movement, and the alternative, re-fetching a
 * series per time zone, buys nothing an accountant would notice.
 */

import { normalizeAssetUnit } from '@/utils/asset-units';

export type FiatRateMode = 'PeriodAverage' | 'AccountingDate';

export type FiatRateSource = 'supplied' | 'coingecko';

export type SuppliedFiatRate = Readonly<{
	unit: string;
	rate: string;
	from?: Date;
	to?: Date;
}>;

/** `[millisecondsSinceEpoch, price]`, the shape CoinGecko returns. */
export type FiatPricePoint = readonly [number, number];

export type FiatRateContext = Readonly<{ at: Date }> | Readonly<{ from: Date; to: Date }>;

export type FiatRateLookup = Readonly<{ rate: string; source: FiatRateSource }> | null;

/** Rate precision. Prices below a cent still have to survive the round trip. */
const RATE_DECIMALS = 12;

export function utcDayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function toRateString(value: number): string {
	return value.toFixed(RATE_DECIMALS);
}

function meanRateString(rates: readonly string[]): string | null {
	if (rates.length === 0) return null;
	const scale = 10n ** BigInt(RATE_DECIMALS);
	const total = rates.reduce((sum, rate) => sum + parseRateToScaled(rate, RATE_DECIMALS), 0n);
	const mean = total / BigInt(rates.length);
	const whole = mean / scale;
	const fraction = (mean % scale).toString().padStart(RATE_DECIMALS, '0');
	return `${whole}.${fraction}`;
}

/** Reads a decimal rate string into an integer scaled by 10^decimals. */
export function parseRateToScaled(rate: string, decimals: number): bigint {
	const match = /^(\d+)(?:\.(\d*))?$/.exec(rate.trim());
	if (match == null) throw new RangeError(`Invalid fiat rate: ${rate}`);
	const fraction = (match[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
	return BigInt(`${match[1]}${fraction}`);
}

/**
 * Collapses a raw price series into one rate per UTC day. CoinGecko returns
 * five-minute, hourly, or daily points depending on the range asked for, so
 * the caller must not depend on the granularity it happens to get.
 */
export function toDailyAverageRates(points: readonly FiatPricePoint[]): Map<string, string> {
	const sums = new Map<string, { total: number; count: number }>();
	for (const point of points) {
		const [timestamp, price] = point;
		if (!isFiniteNumber(timestamp) || !isFiniteNumber(price) || price <= 0) continue;
		const day = utcDayKey(new Date(timestamp));
		const bucket = sums.get(day) ?? { total: 0, count: 0 };
		bucket.total += price;
		bucket.count += 1;
		sums.set(day, bucket);
	}
	return new Map(Array.from(sums.entries()).map(([day, bucket]) => [day, toRateString(bucket.total / bucket.count)]));
}

function coversDay(rate: SuppliedFiatRate, day: Date): boolean {
	if (rate.from != null && day.getTime() < rate.from.getTime()) return false;
	return !(rate.to != null && day.getTime() >= rate.to.getTime());
}

function eachUtcDay(from: Date, to: Date): string[] {
	const days: string[] = [];
	const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
	while (cursor.getTime() < to.getTime()) {
		days.push(utcDayKey(cursor));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return days.length === 0 ? [utcDayKey(from)] : days;
}

export type FiatRateTable = Readonly<{
	currency: string;
	mode: FiatRateMode;
	rateFor: (unit: string, context: FiatRateContext) => FiatRateLookup;
}>;

export function createFiatRateTable(input: {
	currency: string;
	mode: FiatRateMode;
	/** Caller-supplied rates. These win over any fetched series. */
	supplied?: readonly SuppliedFiatRate[];
	/** Daily rates per asset unit, as produced by `toDailyAverageRates`. */
	daily?: ReadonlyMap<string, ReadonlyMap<string, string>>;
}): FiatRateTable {
	const supplied = (input.supplied ?? []).map((rate) => ({ ...rate, unit: normalizeAssetUnit(rate.unit) }));
	const daily: ReadonlyMap<string, ReadonlyMap<string, string>> = input.daily ?? new Map();

	function suppliedRate(unit: string, day: Date): FiatRateLookup {
		const match = supplied.find((rate) => rate.unit === unit && coversDay(rate, day));
		return match == null ? null : { rate: match.rate, source: 'supplied' };
	}

	function seriesRate(unit: string, context: FiatRateContext): FiatRateLookup {
		const series = daily.get(unit);
		if (series == null) return null;
		if ('at' in context) {
			const rate = series.get(utcDayKey(context.at));
			return rate == null ? null : { rate, source: 'coingecko' };
		}
		const rates = eachUtcDay(context.from, context.to)
			.map((day) => series.get(day))
			.filter((rate): rate is string => rate != null);
		const mean = meanRateString(rates);
		return mean == null ? null : { rate: mean, source: 'coingecko' };
	}

	return {
		currency: input.currency,
		mode: input.mode,
		rateFor(rawUnit, context) {
			const unit = normalizeAssetUnit(rawUnit);
			const day = 'at' in context ? context.at : context.from;
			return suppliedRate(unit, day) ?? seriesRate(unit, context);
		},
	};
}
