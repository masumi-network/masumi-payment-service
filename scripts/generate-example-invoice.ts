/**
 * Generates an example invoice PDF and HTML to preview the template design.
 *
 * Usage:
 *   npx tsx scripts/generate-example-invoice.ts
 *
 * Outputs:
 *   scripts/example-invoice.pdf
 *   scripts/example-invoice.html
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
	generateInvoiceGroups,
	resolveInvoiceConfig,
	generateInvoiceHTML,
	type InvoiceSeller,
	type InvoiceBuyer,
} from '../src/utils/invoice/template';
import { generateInvoicePDFBase64 } from '../src/utils/invoice/pdf-generator';

const __dirname = dirname(fileURLToPath(import.meta.url));

const seller: InvoiceSeller = {
	country: 'Germany',
	city: 'Berlin',
	zipCode: '10115',
	street: 'Friedrichstraße',
	streetNumber: '123',
	email: 'billing@acme-tech.io',
	phone: '+49 30 1234567',
	name: 'Max Mustermann',
	companyName: 'ACME Technologies GmbH',
	vatNumber: 'DE987654321',
};

const buyer: InvoiceBuyer = {
	country: 'Austria',
	city: 'Vienna',
	zipCode: '1010',
	street: 'Kärntner Straße',
	streetNumber: '42',
	email: 'procurement@client-corp.at',
	phone: '+43 1 9876543',
	name: 'Anna Schmidt',
	companyName: 'Client Corp AG',
	vatNumber: 'ATU12345678',
};

const items = [
	{
		name: 'AI Agent — Document Summariser',
		quantity: 12,
		price: 24.5,
		decimals: 6,
		conversionFactor: 2_450_000,
		convertedUnit: '',
		conversionDate: new Date('2026-02-15T00:00:00.000Z'),
	},
	{
		name: 'AI Agent — Code Reviewer',
		quantity: 5,
		price: 89.0,
		decimals: 6,
		conversionFactor: 8_900_000,
		convertedUnit: '',
		conversionDate: new Date('2026-02-20T00:00:00.000Z'),
	},
	{
		name: 'AI Agent — Data Classifier',
		quantity: 3,
		price: 150.0,
		decimals: 6,
		conversionFactor: 15_000_000,
		convertedUnit: '',
		conversionDate: new Date('2026-02-25T00:00:00.000Z'),
	},
];

const vatRate = 0.19;
const invoiceGroups = generateInvoiceGroups(items, vatRate);

const config = resolveInvoiceConfig(
	'eur',
	{
		language: 'en-us',
		localizationFormat: 'en-us',
		date: '2026-03-01',
		description: 'Re: AI Agent Services — February 2026',
		greeting: 'Thank you for your continued partnership.',
		closing: 'Best regards,',
		signature: 'ACME Technologies — Accounts Receivable',
		footer:
			'ACME Technologies GmbH · Friedrichstraße 123, 10115 Berlin · HRB 12345 · Managing Director: Max Mustermann',
		terms: 'Payment is due within 30 days of the invoice date. Late payments may incur interest at the statutory rate.',
		privacy:
			'We process your personal data in accordance with the EU General Data Protection Regulation (GDPR). For details, see our privacy policy at https://acme-tech.io/privacy.',
	},
	{ invoiceType: 'monthly' },
);

const invoiceId = 'INV-24-0312-1';

async function main() {
	// Generate PDF
	const { pdfBase64 } = await generateInvoicePDFBase64(invoiceGroups, seller, buyer, config, invoiceId, null, true, {
		invoiceType: 'monthly',
		servicePeriod: 'February 2026',
	});

	const pdfPath = resolve(__dirname, 'example-invoice.pdf');
	writeFileSync(pdfPath, Buffer.from(pdfBase64, 'base64'));
	console.log(`PDF written to ${pdfPath}`);

	// Generate HTML
	const html = generateInvoiceHTML(config, seller, buyer, invoiceGroups, invoiceId, null, true, {
		invoiceType: 'monthly',
	});

	const htmlPath = resolve(__dirname, 'example-invoice.html');
	writeFileSync(htmlPath, html, 'utf-8');
	console.log(`HTML written to ${htmlPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
