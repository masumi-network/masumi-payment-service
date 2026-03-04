import { getServicePeriodLabel, mergePaymentsById, validateInvoiceCompliance } from './compliance';

describe('invoice compliance helpers', () => {
	it('merges payment arrays by id without duplicates', () => {
		const merged = mergePaymentsById(
			[
				{ id: 'a', value: 1 },
				{ id: 'b', value: 2 },
			],
			[
				{ id: 'b', value: 999 },
				{ id: 'c', value: 3 },
			],
		);

		expect(merged).toEqual([
			{ id: 'a', value: 1 },
			{ id: 'b', value: 2 },
			{ id: 'c', value: 3 },
		]);
	});

	it('requires seller VAT number when VAT is applied', () => {
		expect(() =>
			validateInvoiceCompliance(
				{
					reverseCharge: false,
					seller: { vatNumber: null },
					buyer: { vatNumber: null },
				},
				0.19,
			),
		).toThrow('Seller VAT number is required');
	});

	it('requires buyer VAT number when reverse charge is enabled', () => {
		expect(() =>
			validateInvoiceCompliance(
				{
					reverseCharge: true,
					seller: { vatNumber: 'DE123' },
					buyer: { vatNumber: null },
				},
				0,
			),
		).toThrow('Buyer VAT number is required');
	});

	it('accepts valid VAT setup', () => {
		expect(() =>
			validateInvoiceCompliance(
				{
					reverseCharge: true,
					seller: { vatNumber: 'DE123' },
					buyer: { vatNumber: 'CZ456' },
				},
				0,
			),
		).not.toThrow();
	});

	it('formats service period in requested localization', () => {
		const en = getServicePeriodLabel(2026, 0, 'en-us');
		const de = getServicePeriodLabel(2026, 0, 'de');

		expect(en).toContain('2026');
		expect(de).toContain('2026');
		expect(en).not.toBe('');
		expect(de).not.toBe('');
	});
});
