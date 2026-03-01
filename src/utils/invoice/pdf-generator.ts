import html_to_pdf from 'html-pdf-node';
import {
	generateInvoiceHTML,
	ResolvedInvoiceConfig,
	InvoiceGroup,
	InvoiceSeller,
	InvoiceBuyer,
	extractInvoiceTexts,
} from './template';

const DEFAULT_PDF_OPTIONS: html_to_pdf.Options = {
	format: 'A4',
	margin: {
		top: '0.25in',
		right: '0.5in',
		bottom: '0.25in',
		left: '0.5in',
	},
	printBackground: true,
};

async function htmlToPdfBase64(html: string): Promise<string> {
	const file: html_to_pdf.File = { content: html };
	return new Promise<string>((resolve, reject) => {
		html_to_pdf.generatePdf(file, DEFAULT_PDF_OPTIONS, (err: Error | null, buffer: Buffer) => {
			if (err) {
				reject(new Error(`PDF generation failed: ${err.message}`));
			} else {
				resolve(buffer.toString('base64'));
			}
		});
	});
}

export async function generateInvoicePDF(
	invoiceGroups: InvoiceGroup[],
	seller: InvoiceSeller,
	buyer: InvoiceBuyer,
	invoiceConfig: ResolvedInvoiceConfig,
	newInvoiceId: string,
	cancellationNotice: {
		cancellationTitle: string;
		cancellationDescription: string;
	} | null,
	includeCoingeckoAttribution: boolean = false,
	options?: { invoiceType?: 'monthly'; isCancellation?: boolean; reverseCharge?: boolean },
): Promise<{ pdfBase64: string }> {
	try {
		const invoiceHtml = generateInvoiceHTML(
			invoiceConfig,
			seller,
			buyer,
			invoiceGroups,
			newInvoiceId,
			cancellationNotice,
			includeCoingeckoAttribution,
			options,
		);
		const pdfBase64 = await htmlToPdfBase64(invoiceHtml);
		return { pdfBase64 };
	} catch (error) {
		throw new Error(`PDF generation failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function generateInvoicePDFBase64(
	invoiceGroups: InvoiceGroup[],
	seller: InvoiceSeller,
	buyer: InvoiceBuyer,
	invoiceConfig: ResolvedInvoiceConfig,
	newInvoiceId: string,
	cancellationNotice: {
		cancellationTitle: string;
		cancellationDescription: string;
	} | null,
	includeCoingeckoAttribution: boolean = false,
	options?: { invoiceType?: 'monthly'; isCancellation?: boolean; reverseCharge?: boolean },
): Promise<{ pdfBase64: string }> {
	const invoice = await generateInvoicePDF(
		invoiceGroups,
		seller,
		buyer,
		invoiceConfig,
		newInvoiceId,
		cancellationNotice,
		includeCoingeckoAttribution,
		options,
	);
	return { pdfBase64: invoice.pdfBase64 };
}

export async function generateCancellationInvoicePDFBase64(
	originalGroups: InvoiceGroup[],
	originalSeller: InvoiceSeller,
	originalBuyer: InvoiceBuyer,
	invoiceConfig: ResolvedInvoiceConfig,
	cancellationInvoiceId: string,
	originalInvoiceNumber: string,
	originalInvoiceDate: string,
	includeCoingeckoAttribution: boolean = false,
	options?: { reverseCharge?: boolean },
): Promise<{ pdfBase64: string }> {
	// Deep copy and negate all amounts
	const negatedGroups: InvoiceGroup[] = originalGroups.map((group) => ({
		vatRate: group.vatRate,
		netTotal: -group.netTotal,
		vatAmount: -group.vatAmount,
		grossTotal: -group.grossTotal,
		items: group.items.map((item) => ({
			...item,
			price: -item.price,
			priceWithoutVat: -item.priceWithoutVat,
			priceWithVat: -item.priceWithVat,
			vatAmount: -item.vatAmount,
		})),
	}));

	const texts = extractInvoiceTexts(invoiceConfig.language);
	const cancellationNotice = {
		cancellationTitle: texts.cancellationInvoice,
		cancellationDescription: texts.cancellationDefault(originalInvoiceNumber, originalInvoiceDate),
	};

	const invoiceHtml = generateInvoiceHTML(
		invoiceConfig,
		originalSeller,
		originalBuyer,
		negatedGroups,
		cancellationInvoiceId,
		cancellationNotice,
		includeCoingeckoAttribution,
		{ invoiceType: 'monthly', isCancellation: true, reverseCharge: options?.reverseCharge },
	);

	const pdfBase64 = await htmlToPdfBase64(invoiceHtml);
	return { pdfBase64 };
}
