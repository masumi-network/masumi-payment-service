import { describe, expect, it } from '@jest/globals';
import { fiatAssetUnit } from '@/utils/asset-units';
import { convertAmountsToFiat, convertAtomicToFiat, withFiatAmount } from './convert';
import { createFiatRateTable, toDailyAverageRates, utcDayKey } from './rates';

const ADA = 'lovelace';
const USDM = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';

function dailyTable(rates: Record<string, string>, mode: 'PeriodAverage' | 'AccountingDate' = 'AccountingDate') {
	return createFiatRateTable({
		currency: 'usd',
		mode,
		daily: new Map([[ADA, new Map(Object.entries(rates))]]),
	});
}

describe('fiat daily rates', () => {
	it('averages every price point of a UTC day, whatever the granularity', () => {
		const daily = toDailyAverageRates([
			[Date.UTC(2026, 7, 1, 1), 0.4],
			[Date.UTC(2026, 7, 1, 13), 0.6],
			[Date.UTC(2026, 7, 2, 5), 1],
		]);
		expect(daily.get('2026-08-01')).toBe('0.500000000000');
		expect(daily.get('2026-08-02')).toBe('1.000000000000');
	});

	it('drops points that carry no usable price', () => {
		const daily = toDailyAverageRates([
			[Date.UTC(2026, 7, 1), Number.NaN],
			[Date.UTC(2026, 7, 1), 0],
			[Date.UTC(2026, 7, 1), 0.5],
		]);
		expect(daily.get('2026-08-01')).toBe('0.500000000000');
	});

	it('reads a rate on the accounting day', () => {
		const table = dailyTable({ '2026-08-01': '0.500000000000' });
		expect(table.rateFor(ADA, { at: new Date('2026-08-01T09:00:00Z') })).toEqual({
			rate: '0.500000000000',
			source: 'coingecko',
		});
	});

	it('has no rate for a day the series never covered', () => {
		const table = dailyTable({ '2026-08-01': '0.500000000000' });
		expect(table.rateFor(ADA, { at: new Date('2026-08-02T09:00:00Z') })).toBeNull();
	});

	it('averages the days inside a bucket', () => {
		const table = dailyTable({ '2026-08-01': '0.400000000000', '2026-08-02': '0.600000000000' }, 'PeriodAverage');
		expect(
			table.rateFor(ADA, { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-08-03T00:00:00Z') }),
		).toEqual({ rate: '0.500000000000', source: 'coingecko' });
	});

	it('prefers a caller-supplied rate over the fetched series', () => {
		const table = createFiatRateTable({
			currency: 'usd',
			mode: 'AccountingDate',
			supplied: [{ unit: ADA, rate: '1.25' }],
			daily: new Map([[ADA, new Map([['2026-08-01', '0.5']])]]),
		});
		expect(table.rateFor(ADA, { at: new Date('2026-08-01T00:00:00Z') })).toEqual({
			rate: '1.25',
			source: 'supplied',
		});
	});

	it('honours the validity window of a supplied rate', () => {
		const table = createFiatRateTable({
			currency: 'usd',
			mode: 'AccountingDate',
			supplied: [{ unit: ADA, rate: '1.25', from: new Date('2026-08-02T00:00:00Z') }],
			daily: new Map([[ADA, new Map([['2026-08-01', '0.500000000000']])]]),
		});
		expect(table.rateFor(ADA, { at: new Date('2026-08-01T00:00:00Z') })?.source).toBe('coingecko');
		expect(table.rateFor(ADA, { at: new Date('2026-08-02T00:00:00Z') })?.source).toBe('supplied');
	});

	it('names the UTC day of an instant', () => {
		expect(utcDayKey(new Date('2026-08-01T23:59:59Z'))).toBe('2026-08-01');
	});
});

describe('fiat conversion', () => {
	it('converts lovelace at the given rate', () => {
		expect(convertAtomicToFiat(100_000_000n, 6, '0.42')).toBe(42_000_000n);
	});

	it('rounds half away from zero instead of truncating', () => {
		expect(convertAtomicToFiat(1n, 6, '0.5')).toBe(1n);
		expect(convertAtomicToFiat(-1n, 6, '0.5')).toBe(-1n);
	});

	it('adds up every asset of a metric', () => {
		const table = createFiatRateTable({
			currency: 'usd',
			mode: 'AccountingDate',
			supplied: [
				{ unit: ADA, rate: '0.5' },
				{ unit: USDM, rate: '1' },
			],
		});
		const conversion = convertAmountsToFiat(
			[
				{ unit: ADA, amount: 100_000_000n },
				{ unit: USDM, amount: 200_000_000n },
			],
			table,
			{ at: new Date('2026-08-01T00:00:00Z') },
		);
		expect(conversion.amount).toBe(250_000_000n);
		expect(conversion.missingUnits).toEqual([]);
	});

	it('refuses to convert a metric when one of its assets has no rate', () => {
		const table = createFiatRateTable({
			currency: 'usd',
			mode: 'AccountingDate',
			supplied: [{ unit: ADA, rate: '0.5' }],
		});
		const result = withFiatAmount(
			[
				{ unit: ADA, amount: 100_000_000n },
				{ unit: USDM, amount: 200_000_000n },
			],
			table,
			{ at: new Date('2026-08-01T00:00:00Z') },
		);
		expect(result.missingUnits).toEqual([USDM]);
		expect(result.amounts?.some((amount) => amount.unit === fiatAssetUnit('usd'))).toBe(false);
	});

	it('ignores a zero amount, so an untouched asset never blocks a conversion', () => {
		const table = createFiatRateTable({
			currency: 'usd',
			mode: 'AccountingDate',
			supplied: [{ unit: ADA, rate: '0.5' }],
		});
		const result = withFiatAmount(
			[
				{ unit: ADA, amount: 2_000_000n },
				{ unit: USDM, amount: 0n },
			],
			table,
			{ at: new Date('2026-08-01T00:00:00Z') },
		);
		expect(result.missingUnits).toEqual([]);
		expect(result.amounts).toContainEqual({ unit: fiatAssetUnit('usd'), amount: 1_000_000n });
	});
});

describe('fiat transaction-time rates', () => {
	const POINTS = [
		[Date.UTC(2026, 7, 1, 8, 0), 0.4],
		[Date.UTC(2026, 7, 1, 9, 0), 0.5],
		[Date.UTC(2026, 7, 1, 10, 0), 0.9],
	] as const;

	function pointTable(mode: 'AccountingDate' | 'TransactionTime') {
		return createFiatRateTable({
			currency: 'usd',
			mode,
			daily: new Map([[ADA, new Map([['2026-08-01', '0.600000000000']])]]),
			points: new Map([[ADA, POINTS]]),
		});
	}

	it('takes the price point closest to the transaction, not the day average', () => {
		const table = pointTable('TransactionTime');
		expect(table.rateFor(ADA, { at: new Date('2026-08-01T09:40:00Z') })).toEqual({
			rate: '0.900000000000',
			source: 'coingecko',
		});
		expect(table.rateFor(ADA, { at: new Date('2026-08-01T08:20:00Z') })).toEqual({
			rate: '0.400000000000',
			source: 'coingecko',
		});
	});

	it('leaves the day average alone in every other mode', () => {
		const table = pointTable('AccountingDate');
		expect(table.rateFor(ADA, { at: new Date('2026-08-01T09:40:00Z') })).toEqual({
			rate: '0.600000000000',
			source: 'coingecko',
		});
	});

	it('falls back to the day average when no price point covers the report', () => {
		const table = createFiatRateTable({
			currency: 'usd',
			mode: 'TransactionTime',
			daily: new Map([[ADA, new Map([['2026-08-01', '0.600000000000']])]]),
		});
		expect(table.rateFor(ADA, { at: new Date('2026-08-01T09:40:00Z') })).toEqual({
			rate: '0.600000000000',
			source: 'coingecko',
		});
	});

	it('keeps a supplied rate ahead of any price point', () => {
		const table = createFiatRateTable({
			currency: 'usd',
			mode: 'TransactionTime',
			supplied: [{ unit: ADA, rate: '2.5' }],
			points: new Map([[ADA, POINTS]]),
		});
		expect(table.rateFor(ADA, { at: new Date('2026-08-01T09:40:00Z') })).toEqual({
			rate: '2.5',
			source: 'supplied',
		});
	});
});
