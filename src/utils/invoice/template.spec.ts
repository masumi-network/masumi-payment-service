import { invoiceOptionsSchema } from './template';

describe('invoice template schema', () => {
	it('rejects invalid invoice date values', () => {
		const result = invoiceOptionsSchema?.safeParse({
			date: '2026-13-40',
		});

		expect(result?.success).toBe(false);
	});

	it('accepts valid invoice date values', () => {
		const result = invoiceOptionsSchema?.safeParse({
			date: '2026-03-01',
		});

		expect(result?.success).toBe(true);
	});
});
