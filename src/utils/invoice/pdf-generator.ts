import html_to_pdf from 'html-pdf-node';
import { generateInvoiceHTML } from './template';
import { z } from 'zod';
import { postGenerateInvoiceSchemaInput } from '@/routes/api/invoice/index';

type InvoiceData = z.infer<typeof postGenerateInvoiceSchemaInput>;

export async function generateInvoicePDF(
  invoiceData: InvoiceData,
): Promise<Buffer> {
  try {
    // Generate HTML content
    const htmlContent = generateInvoiceHTML(invoiceData);

    // Default PDF options - always A4 format
    const defaultOptions: html_to_pdf.Options = {
      format: 'A4',
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      printBackground: true,
    };

    // Create PDF file object
    const file: html_to_pdf.File = {
      content: htmlContent,
    };

    // Generate PDF using callback-based API wrapped in Promise
    return new Promise<Buffer>((resolve, reject) => {
      html_to_pdf.generatePdf(
        file,
        defaultOptions,
        (err: Error | null, buffer: Buffer) => {
          if (err) {
            reject(new Error(`PDF generation failed: ${err.message}`));
          } else {
            resolve(buffer);
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
  invoiceData: InvoiceData,
): Promise<string> {
  const pdfBuffer = await generateInvoicePDF(invoiceData);
  return pdfBuffer.toString('base64');
}
