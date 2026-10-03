import { describe, expect, it } from '@jest/globals';
import type { ReportCsvMetadata } from './csv';
import { createReportReadme } from './export-readme';
import type { ReportFiatMetadata, ReportFiatRate } from './fiat';

const FROM = new Date('2026-08-01T00:00:00.000Z');
const TO = new Date('2026-08-04T00:00:00.000Z');
const ADA = 'lovelace';

function adaRate(overrides: Partial<ReportFiatRate> = {}): ReportFiatRate {
	return {
		unit: ADA,
		coinId: 'cardano',
		rate: '0.500000000000',
		source: 'coingecko',
		provenance: {
			cadence: 'daily',
			sampleCount: 2,
			requestedDayCount: 3,
			firstSampleAt: '2026-08-01',
			lastSampleAt: '2026-08-03',
			currency: 'usd',
		},
		...overrides,
	};
}

function fiat(overrides: Partial<ReportFiatMetadata> = {}): ReportFiatMetadata {
	return {
		currency: 'usd',
		mode: 'PeriodAverage',
		provider: 'coingecko',
		attribution: 'Exchange rates by CoinGecko',
		isDemoKey: false,
		demoHistoryDays: null,
		completeness: 'complete',
		unpricedUnits: [],
		rates: [adaRate()],
		fetchedAt: new Date('2026-08-04T10:11:12.000Z'),
		...overrides,
	};
}

function metadata(overrides: Partial<ReportCsvMetadata> = {}): ReportCsvMetadata {
	return {
		generatedAt: new Date('2026-08-04T10:11:12.000Z'),
		asOf: TO,
		paymentSource: {
			id: 'source-1',
			network: 'Preprod',
			paymentSourceType: 'Web3CardanoV1',
			feeRatePermille: 50,
			smartContractAddress: 'addr-contract',
			deletedAt: null,
		},
		filters: {
			paymentSourceId: 'source-1',
			managedWalletIds: [],
			externalAddresses: [],
			roles: ['Seller'],
			states: ['Withdrawn'],
			from: FROM,
			to: TO,
			dateBasis: 'CreatedAt',
			revenueMode: 'RequestedGross',
			timeZone: 'Etc/UTC',
		},
		requestedBucket: 'Auto',
		bucket: 'Day',
		fiat: fiat(),
		warnings: [],
		...overrides,
	};
}

function readme(overrides: Partial<ReportCsvMetadata> = {}): string {
	return createReportReadme(metadata(overrides)).toString('utf8');
}

describe('export README currency section', () => {
	it('names the observations behind a bucket rate, so a reader can redo the mean', () => {
		expect(readme()).toContain(
			'- 1 ADA = 0.500000000000 USD, the mean of 2 daily samples from 2026-08-01 to 2026-08-03, out of 3 days in the period, read from CoinGecko `cardano`',
		);
	});

	it('discloses partial coverage by printing samples against the days the period asked for', () => {
		const text = readme({ fiat: fiat({ rates: [adaRate()] }) });
		// The period covers three days and only two carried a sample. A reader who
		// sees 2 of 3 knows the average is not the whole period.
		expect(text).toContain('out of 3 days in the period');
	});

	it('records when the provider answered', () => {
		expect(readme()).toContain('The provider answered at 2026-08-04T10:11:12.000Z.');
	});

	it('marks a caller-supplied rate as supplied instead of inventing provenance', () => {
		const supplied = adaRate({ source: 'supplied', coinId: null, provenance: null });
		expect(
			readme({ fiat: fiat({ rates: [supplied], provider: 'supplied', attribution: null, fetchedAt: null }) }),
		).toContain('- 1 ADA = 0.500000000000 USD, supplied with the request');
	});

	it('leaves the provider answer line out when no provider was called', () => {
		const supplied = adaRate({ source: 'supplied', coinId: null, provenance: null });
		expect(
			readme({ fiat: fiat({ rates: [supplied], provider: 'supplied', attribution: null, fetchedAt: null }) }),
		).not.toContain('The provider answered at');
	});
});
