import { generateCancellationInvoicePDFBase64 } from './pdf-generator';
import { generateInvoiceGroups, resolveInvoiceConfig } from './template';

describe('cancellation invoice PDF', () => {
	it('embeds cancellation reason text when provided', async () => {
		const config = resolveInvoiceConfig('eur', {
			language: 'en-us',
			localizationFormat: 'en-us',
			date: '2026-03-01',
		});

		const invoiceGroups = generateInvoiceGroups(
			[
				{
					name: 'Service Fee',
					quantity: 1,
					price: 150,
					decimals: 6,
					conversionFactor: 1,
					convertedUnit: '',
					conversionDate: new Date('2026-03-01T00:00:00.000Z'),
				},
			],
			0,
		);

		const seller = {
			country: 'Germany',
			city: 'Berlin',
			zipCode: '10115',
			street: 'Seller Street',
			streetNumber: '1',
			email: null,
			phone: null,
			name: null,
			companyName: 'Seller GmbH',
			vatNumber: 'DE123456789',
		};

		const buyer = {
			country: 'Czech Republic',
			city: 'Prague',
			zipCode: '11000',
			street: 'Buyer Street',
			streetNumber: '2',
			email: null,
			phone: null,
			name: null,
			companyName: 'Buyer s.r.o.',
			vatNumber: 'CZ12345678',
		};

		const reason = 'Manual regeneration requested';
		const { pdfBase64 } = await generateCancellationInvoicePDFBase64(
			invoiceGroups,
			seller,
			buyer,
			config,
			'INV-0001-CN',
			'INV-0001',
			'03/01/2026',
			false,
			{ cancellationReason: reason },
		);

		const pdfText = Buffer.from(pdfBase64, 'base64').toString('latin1');
		expect(pdfText).toContain(reason);
		expect(pdfText).toContain('Reason');
	});
});
