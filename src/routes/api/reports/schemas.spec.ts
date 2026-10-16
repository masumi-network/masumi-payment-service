import { describe, expect, it } from '@jest/globals';
import { HotWalletType } from '@/generated/prisma/client';
import { reportFacetsOutputSchema, reportFilterSchema, reportTransactionsInputSchema } from './schemas';

const validFilter = {
	paymentSourceId: 'source-1',
	from: '2026-01-01T00:00:00.000Z',
	to: '2026-02-01T00:00:00.000Z',
};

describe('reportFilterSchema', () => {
	it('applies safe report defaults', () => {
		const result = reportFilterSchema.parse(validFilter);
		expect(result).toMatchObject({
			roles: ['Buyer', 'Seller'],
			dateBasis: 'RevenueRecognizedAt',
			revenueMode: 'Billable',
			timeZone: 'Etc/UTC',
		});
		expect(result.from).toEqual(new Date(validFilter.from));
		expect(result.to).toEqual(new Date(validFilter.to));
	});

	it('rejects an inverted range', () => {
		expect(() => reportFilterSchema.parse({ ...validFilter, from: validFilter.to, to: validFilter.from })).toThrow(
			'to must be after from',
		);
	});

	it('rejects an invalid IANA time zone', () => {
		expect(() => reportFilterSchema.parse({ ...validFilter, timeZone: 'Mars/Olympus' })).toThrow(
			'Invalid IANA time zone',
		);
	});

	it('rejects a report range longer than ten years', () => {
		expect(() => reportFilterSchema.parse({ ...validFilter, from: '2010-01-01T00:00:00.000Z' })).toThrow(
			'Report range must not exceed 3660 days',
		);
	});

	it('accepts exact caller-supplied fiat rates', () => {
		const result = reportFilterSchema.parse({
			...validFilter,
			fiat: {
				currency: 'usd',
				suppliedRates: [{ unit: 'lovelace', rate: '0.621234567890123456' }],
			},
		});
		expect(result.fiat?.suppliedRates?.[0].rate).toBe('0.621234567890123456');
	});
});

describe('reportTransactionsInputSchema', () => {
	it('defaults to 50 rows and caps pages at 100', () => {
		expect(reportTransactionsInputSchema.parse(validFilter).limit).toBe(50);
		expect(() => reportTransactionsInputSchema.parse({ ...validFilter, limit: 101 })).toThrow();
	});
});

describe('reportFacetsOutputSchema', () => {
	const wallet = {
		id: 'wallet-1',
		paymentSourceId: 'source-1',
		walletAddress: 'addr_test1wallet',
		walletVkey: 'wallet-vkey',
		collectionAddress: null,
		note: null,
		deletedAt: null,
	};

	const fiatCapability = {
		isConfigured: true,
		isDemoKey: true,
		historyDays: 365,
		earliestPriceableDate: new Date('2026-01-01T00:00:00.000Z'),
		currencies: ['usd'],
		modes: ['PeriodAverage' as const],
		attribution: 'Exchange rates by CoinGecko',
		setupHint: 'Set COINGECKO_API_KEY.',
	};

	it('allows only managed buyer and seller wallet types', () => {
		expect(
			reportFacetsOutputSchema.safeParse({
				fiat: fiatCapability,
				paymentSources: [],
				managedWallets: [{ ...wallet, type: HotWalletType.Selling }],
			}).success,
		).toBe(true);
		expect(
			reportFacetsOutputSchema.safeParse({
				fiat: fiatCapability,
				paymentSources: [],
				managedWallets: [{ ...wallet, type: HotWalletType.Funding }],
			}).success,
		).toBe(false);
	});
});
