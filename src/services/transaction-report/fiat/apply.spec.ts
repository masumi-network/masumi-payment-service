import { describe, expect, it } from '@jest/globals';
import { fiatAssetUnit } from '@/utils/asset-units';
import type { ReportRow } from '../records';
import { applyFiatToReportRows } from './apply';
import { createFiatRateTable } from './rates';

const USD = fiatAssetUnit('usd');
const WINDOW = { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-08-10T00:00:00Z') };

/** Only the fields the fiat pass reads. The rest of a row is irrelevant here. */
function sellerRow(overrides: Partial<ReportRow> = {}): ReportRow {
	return {
		role: 'Seller',
		createdAt: new Date('2026-08-02T00:00:00Z'),
		requestedFunds: [{ unit: 'lovelace', amount: 3_000_001n }],
		withdrawnForBuyer: [],
		withdrawnForSeller: [],
		timestamps: {
			createdAt: new Date('2026-08-02T00:00:00Z'),
			fundsLockedAt: new Date('2026-08-02T00:00:00Z'),
			sellerRevenueRecognizedAt: new Date('2026-08-03T00:00:00Z'),
			buyerGrossSpendAt: null,
			buyerReturnedAt: null,
		},
		seller: {
			grossRevenue: [{ unit: 'lovelace', amount: 3_000_001n }],
			protocolFee: { amounts: [{ unit: 'lovelace', amount: 1n }], completeness: 'exact' },
			cardanoFees: [{ unit: 'lovelace', amount: 1n }],
			netRevenue: [{ unit: 'lovelace', amount: 2_999_999n }],
		},
		buyer: null,
		...overrides,
	} as unknown as ReportRow;
}

function table(rate: string, mode: 'PeriodAverage' | 'AccountingDate' = 'AccountingDate') {
	return createFiatRateTable({ currency: 'usd', mode, supplied: [{ unit: 'lovelace', rate }] });
}

function fiatOf(amounts: unknown): string {
	const list = amounts as ReadonlyArray<{ unit: string; amount: bigint }> | null;
	return list?.find((amount) => amount.unit === USD)?.amount.toString() ?? 'none';
}

describe('applyFiatToReportRows', () => {
	it('keeps net equal to its own parts after rounding', () => {
		const { rows } = applyFiatToReportRows([sellerRow()], table('0.333333'), 'RevenueRecognizedAt', WINDOW);
		const seller = rows[0]?.seller;
		const gross = BigInt(fiatOf(seller?.grossRevenue));
		const fee = BigInt(fiatOf(seller?.protocolFee.amounts));
		const cardanoFees = BigInt(fiatOf(seller?.cardanoFees));
		expect(fiatOf(seller?.netRevenue)).toBe((gross - fee - cardanoFees).toString());
	});

	it('leaves an unpriced asset unconverted and names it', () => {
		const row = sellerRow({
			seller: {
				grossRevenue: [{ unit: 'sometoken', amount: 5n }],
				protocolFee: { amounts: null, completeness: 'not_applicable' },
				cardanoFees: [],
				netRevenue: null,
			},
		} as unknown as Partial<ReportRow>);
		const result = applyFiatToReportRows([row], table('0.5'), 'RevenueRecognizedAt', WINDOW);
		expect(result.missingUnits).toEqual(['sometoken']);
		expect(fiatOf(result.rows[0]?.seller?.grossRevenue)).toBe('none');
	});

	it('converts an empty figure to a zero fiat figure', () => {
		const row = sellerRow({
			seller: {
				grossRevenue: [],
				protocolFee: { amounts: null, completeness: 'not_applicable' },
				cardanoFees: [],
				netRevenue: [],
			},
		} as unknown as Partial<ReportRow>);
		const { rows } = applyFiatToReportRows([row], table('0.5'), 'RevenueRecognizedAt', WINDOW);
		expect(fiatOf(rows[0]?.seller?.grossRevenue)).toBe('0');
	});
});
