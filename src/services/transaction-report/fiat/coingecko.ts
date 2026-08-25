import Coingecko from '@coingecko/coingecko-typescript';
import createHttpError from 'http-errors';
import { CONFIG } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { MAINNET_USDCX_UNIT, MAINNET_USDM_UNIT, PREPROD_USDM_UNIT, normalizeAssetUnit } from '@/utils/asset-units';
import { toDailyAverageRates, type FiatPricePoint } from './rates';

/**
 * CoinGecko coin ids for the assets a report can hold.
 *
 * Every id was confirmed against CoinGecko's own `platforms.cardano` value, so
 * the id and the on-chain unit describe the same token. Preprod tUSDM has no
 * listing and is priced off mainnet USDM, the same convention the monthly
 * invoice uses.
 */
const COIN_IDS: ReadonlyMap<string, string> = new Map([
	['lovelace', 'cardano'],
	[MAINNET_USDM_UNIT, 'usdm-2'],
	[PREPROD_USDM_UNIT, 'usdm-2'],
	[MAINNET_USDCX_UNIT, 'cicle-xreserve-bridged-usdc-cardano'],
]);

/** Days of history a demo key may read. Beyond this CoinGecko answers 401. */
export const DEMO_HISTORY_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export function getCoinId(unit: string): string | null {
	return COIN_IDS.get(normalizeAssetUnit(unit)) ?? null;
}

export function isFiatRateProviderConfigured(): boolean {
	return CONFIG.COINGECKO_API_KEY != null && CONFIG.COINGECKO_API_KEY !== '';
}

export function isFiatRateProviderDemo(): boolean {
	return CONFIG.IS_COINGECKO_DEMO === true;
}

/** Oldest date a demo key can price, or null when the key is a pro key. */
export function getEarliestPriceableDate(now: Date = new Date()): Date | null {
	return isFiatRateProviderDemo() ? new Date(now.getTime() - DEMO_HISTORY_DAYS * DAY_MS) : null;
}

/**
 * Refuses a range the configured key cannot answer, before any request is
 * made. A demo key returns 401 for older data, which reads as an auth problem
 * and sends the operator looking in the wrong place.
 */
export function assertPriceableRange(from: Date, now: Date = new Date()): void {
	const earliest = getEarliestPriceableDate(now);
	if (earliest == null || from.getTime() >= earliest.getTime()) return;
	throw createHttpError(
		400,
		`The CoinGecko demo key only prices the last ${DEMO_HISTORY_DAYS} days. Start the report on ${earliest
			.toISOString()
			.slice(0, 10)} or later, supply your own rates, or set a CoinGecko pro key.`,
	);
}

function createClient(): Coingecko {
	if (!isFiatRateProviderConfigured()) {
		throw createHttpError(
			400,
			'Fiat conversion needs a CoinGecko API key. Set COINGECKO_API_KEY (and IS_COINGECKO_DEMO for a demo key), or supply your own rates.',
		);
	}
	const apiKey = CONFIG.COINGECKO_API_KEY as string;
	return isFiatRateProviderDemo()
		? new Coingecko({ demoAPIKey: apiKey, environment: 'demo' })
		: new Coingecko({ proAPIKey: apiKey, environment: 'pro' });
}

function toPricePoints(prices: ReadonlyArray<readonly number[]> | undefined): FiatPricePoint[] {
	if (prices == null) return [];
	const points: FiatPricePoint[] = [];
	for (const price of prices) {
		if (price.length < 2) continue;
		points.push([price[0], price[1]]);
	}
	return points;
}

export type FiatRateFetchInput = Readonly<{
	units: readonly string[];
	currency: string;
	from: Date;
	to: Date;
}>;

export type FiatRateFetchResult = Readonly<{
	/** Daily rates per asset unit, ready for `createFiatRateTable`. */
	daily: Map<string, Map<string, string>>;
	/**
	 * The raw series behind those daily rates, kept so a report can price a
	 * transaction at its own time instead of its day. It costs no extra request.
	 */
	points: Map<string, FiatPricePoint[]>;
	/** Units with no CoinGecko listing at all. */
	unsupportedUnits: readonly string[];
}>;

/**
 * Rates already read, keyed by the exact question they answer.
 *
 * A report is read one page at a time, and every page asks for the same window
 * and the same assets. Without this a report spread over ten pages makes ten
 * rounds of provider calls for one answer, and a free demo key runs out of
 * requests before the reader reaches the last page.
 *
 * Entries are shared, not copied. Every reader of a fetch result treats it as
 * read-only, and `createFiatRateTable` stores it behind ReadonlyMap.
 */
const RATE_CACHE_TTL_MS = 5 * 60 * 1000;
const RATE_CACHE_MAX_ENTRIES = 64;
const rateCache = new Map<string, { readAt: number; result: FiatRateFetchResult }>();

function rateCacheKey(input: FiatRateFetchInput): string {
	const units = Array.from(new Set(input.units.map(normalizeAssetUnit))).sort();
	return JSON.stringify([input.currency, units, input.from.toISOString(), input.to.toISOString()]);
}

function readRateCache(key: string, now: number): FiatRateFetchResult | null {
	for (const [cachedKey, entry] of rateCache) {
		if (now - entry.readAt >= RATE_CACHE_TTL_MS) rateCache.delete(cachedKey);
	}
	return rateCache.get(key)?.result ?? null;
}

function writeRateCache(key: string, now: number, result: FiatRateFetchResult): void {
	rateCache.set(key, { readAt: now, result });
	// A Map keeps insertion order, so the first key is the oldest entry.
	while (rateCache.size > RATE_CACHE_MAX_ENTRIES) {
		const oldest = rateCache.keys().next();
		if (oldest.done) break;
		rateCache.delete(oldest.value);
	}
}

/** Empties the rate cache, so one test cannot answer another. */
export function clearFiatRateCache(): void {
	rateCache.clear();
}

/**
 * Reads one daily price series per asset from CoinGecko.
 *
 *
 * The range is padded by a day on each side so a report bucket that starts
 * before the first price point still finds a rate.
 */
export async function fetchDailyFiatRates(input: FiatRateFetchInput): Promise<FiatRateFetchResult> {
	const units = Array.from(new Set(input.units.map(normalizeAssetUnit)));
	const unsupportedUnits = units.filter((unit) => getCoinId(unit) == null);
	const supportedUnits = units.filter((unit) => getCoinId(unit) != null);
	const daily = new Map<string, Map<string, string>>();
	const points = new Map<string, FiatPricePoint[]>();
	if (supportedUnits.length === 0) return { daily, points, unsupportedUnits };

	assertPriceableRange(input.from);
	// After the range guard, so a cached answer cannot smuggle a window the
	// configured key is no longer allowed to read.
	const cacheKey = rateCacheKey(input);
	const readAt = Date.now();
	const cached = readRateCache(cacheKey, readAt);
	if (cached != null) return cached;
	const client = createClient();
	const from = new Date(input.from.getTime() - DAY_MS).toISOString().slice(0, 10);
	const to = new Date(input.to.getTime() + DAY_MS).toISOString().slice(0, 10);

	for (const unit of supportedUnits) {
		const coinId = getCoinId(unit) as string;
		try {
			const chart = await client.coins.marketChart.getRange(coinId, {
				from,
				to,
				vs_currency: input.currency,
			});
			const series = toPricePoints(chart.prices);
			points.set(unit, series);
			daily.set(unit, toDailyAverageRates(series));
		} catch (error) {
			logger.error('CoinGecko rate lookup failed', { coinId, currency: input.currency, error });
			throw createHttpError(
				502,
				`CoinGecko could not price ${coinId} in ${input.currency.toUpperCase()}: ${
					error instanceof Error ? error.message : 'unknown error'
				}`,
			);
		}
	}

	const result = { daily, points, unsupportedUnits };
	writeRateCache(cacheKey, readAt, result);
	return result;
}
