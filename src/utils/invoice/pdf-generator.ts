import html_to_pdf from 'html-pdf-node';
import {
  generateInvoiceHTML,
  ResolvedInvoiceConfig,
  InvoiceGroup,
} from './template';
import { z } from 'zod';
import { postGenerateInvoiceSchemaInput } from '@/routes/api/invoice/index';

type InvoiceData = z.infer<typeof postGenerateInvoiceSchemaInput>;

export async function generateInvoicePDF(
  invoiceGroups: InvoiceGroup[],
  seller: InvoiceData['seller'],
  buyer: InvoiceData['buyer'],
  invoiceConfig: ResolvedInvoiceConfig,
  newInvoiceId: string,
  correctionInvoiceReference: {
    correctionTitle: string;
    correctionDescription: string;
  } | null,
  includeCoingeckoAttribution: boolean = false,
): Promise<{ pdfBase64: string }> {
  try {
    const invoiceHtml = generateInvoiceHTML(
      invoiceConfig,
      seller,
      buyer,
      invoiceGroups,
      newInvoiceId,
      correctionInvoiceReference,
      includeCoingeckoAttribution,
    );

    // Default PDF options - always A4 format
    const defaultOptions: html_to_pdf.Options = {
      format: 'A4',
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      printBackground: true,
    };

    // Create PDF file object
    const file: html_to_pdf.File = {
      content: invoiceHtml,
    };

    // Generate PDF using callback-based API wrapped in Promise
    return new Promise<{ pdfBase64: string }>((resolve, reject) => {
      html_to_pdf.generatePdf(
        file,
        defaultOptions,
        (err: Error | null, buffer: Buffer) => {
          if (err) {
            reject(new Error(`PDF generation failed: ${err.message}`));
          } else {
            resolve({
              pdfBase64: buffer.toString('base64'),
            });
          }
        },
      );
    });
  } catch (error) {
    throw new Error(
      `PDF generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function generateInvoicePDFBase64(
  invoiceGroups: InvoiceGroup[],
  seller: InvoiceData['seller'],
  buyer: InvoiceData['buyer'],
  invoiceConfig: ResolvedInvoiceConfig,
  newInvoiceId: string,
  correctionInvoiceReference: {
    correctionTitle: string;
    correctionDescription: string;
  } | null,
  includeCoingeckoAttribution: boolean = false,
): Promise<{ pdfBase64: string }> {
  const invoice = await generateInvoicePDF(
    invoiceGroups,
    seller,
    buyer,
    invoiceConfig,
    newInvoiceId,
    correctionInvoiceReference,
    includeCoingeckoAttribution,
  );
  return {
    pdfBase64: invoice.pdfBase64,
  };
}
