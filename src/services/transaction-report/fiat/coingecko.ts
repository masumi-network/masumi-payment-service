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
	/** Units with no CoinGecko listing at all. */
	unsupportedUnits: readonly string[];
}>;

/**
 * Reads one daily price series per asset from CoinGecko.
 *
 * The range is padded by a day on each side so a report bucket that starts
 * before the first price point still finds a rate.
 */
export async function fetchDailyFiatRates(input: FiatRateFetchInput): Promise<FiatRateFetchResult> {
	const units = Array.from(new Set(input.units.map(normalizeAssetUnit)));
	const unsupportedUnits = units.filter((unit) => getCoinId(unit) == null);
	const supportedUnits = units.filter((unit) => getCoinId(unit) != null);
	const daily = new Map<string, Map<string, string>>();
	if (supportedUnits.length === 0) return { daily, unsupportedUnits };

	assertPriceableRange(input.from);
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
			daily.set(unit, toDailyAverageRates(toPricePoints(chart.prices)));
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

	return { daily, unsupportedUnits };
}
