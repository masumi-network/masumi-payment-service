import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const config: { COINGECKO_API_KEY?: string; IS_COINGECKO_DEMO?: boolean } = {};

jest.unstable_mockModule('@masumi/payment-core/config', () => ({ CONFIG: config }));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { error: jest.fn() } }));

const {
	assertPriceableRange,
	fetchDailyFiatRates,
	getCoinId,
	getEarliestPriceableDate,
	isFiatRateProviderConfigured,
} = await import('./coingecko');

const NOW = new Date('2026-08-25T00:00:00.000Z');
const USDM = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
const PREPROD_USDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';

describe('CoinGecko rate provider', () => {
	beforeEach(() => {
		config.COINGECKO_API_KEY = 'demo-key';
		config.IS_COINGECKO_DEMO = true;
	});

	it('prices preprod tUSDM off the mainnet listing, which is the only one that exists', () => {
		expect(getCoinId(PREPROD_USDM)).toBe(getCoinId(USDM));
	});

	it('has no coin for an unlisted token', () => {
		expect(getCoinId('deadbeefsometoken')).toBeNull();
	});

	it('refuses a range older than a demo key can read, before making a request', () => {
		expect(() => assertPriceableRange(new Date('2024-01-01T00:00:00Z'), NOW)).toThrow(/365 days/u);
	});

	it('allows a range inside the demo window', () => {
		expect(() => assertPriceableRange(new Date('2026-08-01T00:00:00Z'), NOW)).not.toThrow();
	});

	it('places no limit on a paid key', () => {
		config.IS_COINGECKO_DEMO = false;
		expect(getEarliestPriceableDate(NOW)).toBeNull();
		expect(() => assertPriceableRange(new Date('2019-01-01T00:00:00Z'), NOW)).not.toThrow();
	});

	it('asks the operator to set a key when none is configured', async () => {
		config.COINGECKO_API_KEY = undefined;
		expect(isFiatRateProviderConfigured()).toBe(false);
		await expect(
			fetchDailyFiatRates({ units: ['lovelace'], currency: 'usd', from: NOW, to: NOW }),
		).rejects.toThrow(/COINGECKO_API_KEY/u);
	});

	it('never calls the provider for a report holding only unlisted tokens', async () => {
		config.COINGECKO_API_KEY = undefined;
		const result = await fetchDailyFiatRates({
			units: ['deadbeefsometoken'],
			currency: 'usd',
			from: NOW,
			to: NOW,
		});
		expect(result.unsupportedUnits).toEqual(['deadbeefsometoken']);
		expect(result.daily.size).toBe(0);
	});
});
