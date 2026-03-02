import { jsPDF } from 'jspdf';
import autoTable, { type RowInput } from 'jspdf-autotable';
import {
	extractInvoiceTexts,
	formatCryptoUnitConversion,
	type ResolvedInvoiceConfig,
	type InvoiceGroup,
	type InvoiceSeller,
	type InvoiceBuyer,
} from './template';

// ── Colors (matching HTML template) ────────────────────────────────────────
const C = {
	primary: [31, 59, 115] as [number, number, number], // #1f3b73
	accent: [15, 90, 217] as [number, number, number], // #0f5ad9
	text: [31, 36, 48] as [number, number, number], // #1f2430
	textMuted: [91, 101, 119] as [number, number, number], // #5b6577
	border: [188, 197, 214] as [number, number, number], // #bcc5d6
	white: [255, 255, 255] as [number, number, number],
	warningBg: [255, 246, 224] as [number, number, number], // #fff6e0
	warningBorder: [247, 202, 99] as [number, number, number], // #f7ca63
	warningText: [138, 98, 18] as [number, number, number], // #8a6212
	totalsCardBg: [240, 244, 253] as [number, number, number], // rgba(15,90,217,0.04) approx
};

// ── Layout constants (mm) ──────────────────────────────────────────────────
const PAGE_W = 210;
const PAGE_H = 297;
const ML = 14; // margin left
const MR = 14; // margin right
const MT = 10; // margin top
const CONTENT_W = PAGE_W - ML - MR;
const FOOTER_BOTTOM = PAGE_H - 10; // footer baseline

// ── Helpers ────────────────────────────────────────────────────────────────

function drawRoundedRect(
	doc: jsPDF,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
	style: 'S' | 'F' | 'FD' = 'S',
) {
	doc.roundedRect(x, y, w, h, r, r, style);
}

/** Return the y after writing; handles page overflow check */
function ensureSpace(doc: jsPDF, y: number, needed: number): number {
	if (y + needed > FOOTER_BOTTOM - 10) {
		doc.addPage();
		return MT;
	}
	return y;
}

// ── Main PDF builder ───────────────────────────────────────────────────────

function buildInvoicePDF(
	config: ResolvedInvoiceConfig,
	seller: InvoiceSeller,
	buyer: InvoiceBuyer,
	invoiceGroups: InvoiceGroup[],
	invoiceId: string,
	cancellationNotice: { cancellationTitle: string; cancellationDescription: string } | null,
	includeCoingeckoAttribution: boolean,
	options?: { invoiceType?: 'monthly'; isCancellation?: boolean; reverseCharge?: boolean; servicePeriod?: string },
): jsPDF {
	const {
		title,
		date,
		greeting,
		closing,
		signature,
		footer,
		terms,
		privacy,
		currencyFormatter,
		numberFormatter,
		dateFormatter,
		texts: t,
	} = config;

	const doc = new jsPDF({ unit: 'mm', format: 'a4' });
	doc.setFont('helvetica');

	let y = MT;

	// ── 1. Header ────────────────────────────────────────────────────────
	const invoiceTitle = options?.isCancellation
		? t.cancellationInvoice
		: title || (options?.invoiceType === 'monthly' ? t.monthlyInvoice || t.invoice : t.invoice);

	// Title (right-aligned)
	doc.setFontSize(20);
	doc.setFont('helvetica', 'bold');
	doc.setTextColor(...C.primary);
	doc.text(invoiceTitle.toUpperCase(), PAGE_W - MR, y + 7, { align: 'right' });

	// Invoice # and date
	doc.setFontSize(9);
	doc.setFont('helvetica', 'normal');
	doc.setTextColor(...C.textMuted);
	const metaLine = `${t.invoiceNumber}: ${invoiceId}    ${t.date}: ${dateFormatter.format(date)}`;
	doc.text(metaLine, PAGE_W - MR, y + 13, { align: 'right' });

	// Service period (if provided)
	if (options?.servicePeriod) {
		doc.text(`${t.servicePeriod}: ${options.servicePeriod}`, PAGE_W - MR, y + 17, { align: 'right' });
		y += 22;
	} else {
		y += 18;
	}

	// Header separator
	doc.setDrawColor(...C.border);
	doc.setLineWidth(0.3);
	doc.line(ML, y, PAGE_W - MR, y);
	y += 6;

	// ── 2. Party cards ───────────────────────────────────────────────────
	const cardW = (CONTENT_W - 6) / 2;
	const cardX1 = ML;
	const cardX2 = ML + cardW + 6;

	const drawPartyCard = (
		targetDoc: jsPDF,
		x: number,
		startY: number,
		label: string,
		party: InvoiceSeller | InvoiceBuyer,
	): number => {
		let cy = startY + 5;
		const innerX = x + 4;

		// Label
		targetDoc.setFontSize(8);
		targetDoc.setFont('helvetica', 'bold');
		targetDoc.setTextColor(...C.primary);
		targetDoc.text(label.toUpperCase(), innerX, cy);
		cy += 4;

		// Company name
		if (party.companyName) {
			targetDoc.setFontSize(10);
			targetDoc.setFont('helvetica', 'bold');
			targetDoc.setTextColor(...C.text);
			targetDoc.text(party.companyName, innerX, cy);
			cy += 4;
		}

		// Name
		targetDoc.setFontSize(9);
		targetDoc.setFont('helvetica', 'normal');
		targetDoc.setTextColor(...C.text);
		if (party.name) {
			targetDoc.text(party.name, innerX, cy);
			cy += 3.5;
		}

		// Address
		targetDoc.setTextColor(...C.textMuted);
		targetDoc.text(`${party.street} ${party.streetNumber}`, innerX, cy);
		cy += 3.5;
		targetDoc.text(`${party.zipCode} ${party.city}`, innerX, cy);
		cy += 3.5;
		targetDoc.text(party.country, innerX, cy);
		cy += 4;

		// Meta (email, phone, VAT) — handle text overflow
		targetDoc.setFontSize(8);
		const metaParts: string[] = [];
		if (party.email) metaParts.push(`${t.email}: ${party.email}`);
		if (party.phone) metaParts.push(`${t.phone}: ${party.phone}`);
		if (party.vatNumber) metaParts.push(`${t.vat}: ${party.vatNumber}`);
		if (metaParts.length > 0) {
			const metaText = metaParts.join('  |  ');
			const metaLines = targetDoc.splitTextToSize(metaText, cardW - 8) as string[];
			targetDoc.text(metaLines, innerX, cy);
			cy += metaLines.length * 3.5;
		}

		return cy + 2; // bottom of card content
	};

	// Measure both cards using a temporary doc to get consistent height
	const tempDoc = new jsPDF({ unit: 'mm', format: 'a4' });
	const buyerBottom = drawPartyCard(tempDoc, cardX1, y, t.to, buyer) - y;
	const sellerBottom = drawPartyCard(tempDoc, cardX2, y, t.from, seller) - y;

	const cardH = Math.max(buyerBottom, sellerBottom) + 2;

	// Draw card borders
	doc.setDrawColor(...C.border);
	doc.setLineWidth(0.3);
	drawRoundedRect(doc, cardX1, y, cardW, cardH, 1.5);
	drawRoundedRect(doc, cardX2, y, cardW, cardH, 1.5);

	// Draw card content on actual doc
	drawPartyCard(doc, cardX1, y, t.to, buyer);
	drawPartyCard(doc, cardX2, y, t.from, seller);

	y += cardH + 6;

	// ── 3. Cancellation notice ───────────────────────────────────────────
	if (cancellationNotice) {
		doc.setFontSize(8);
		doc.setFont('helvetica', 'normal');
		const descLines = doc.splitTextToSize(cancellationNotice.cancellationDescription, CONTENT_W - 10) as string[];
		const noticeH = 12 + descLines.length * 3.5;

		y = ensureSpace(doc, y, noticeH + 4);
		doc.setFillColor(...C.warningBg);
		doc.setDrawColor(...C.warningBorder);
		doc.setLineWidth(0.4);
		drawRoundedRect(doc, ML, y, CONTENT_W, noticeH, 2, 'FD');

		doc.setFontSize(10);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.warningText);
		doc.text(cancellationNotice.cancellationTitle.toUpperCase(), ML + 5, y + 6);

		doc.setFontSize(8);
		doc.setFont('helvetica', 'normal');
		doc.text(descLines, ML + 5, y + 11);

		y += noticeH + 4;
	}

	// ── 4. Greeting ──────────────────────────────────────────────────────
	if (greeting) {
		y = ensureSpace(doc, y, 8);
		doc.setFontSize(10);
		doc.setFont('helvetica', 'italic');
		doc.setTextColor(...C.textMuted);
		doc.text(greeting, ML + 2, y);
		y += 6;
	}

	// ── 5. Items table ───────────────────────────────────────────────────
	if (invoiceGroups.length > 0) {
		const tableRows: RowInput[] = [];

		for (const group of invoiceGroups) {
			const vatRateDisplay = numberFormatter.format(group.vatRate * 100);

			// Item rows
			for (const item of group.items) {
				tableRows.push([
					{ content: item.name, styles: { fontSize: 9 } },
					{ content: String(item.quantity), styles: { halign: 'center', fontSize: 9 } },
					{
						content: currencyFormatter.format(item.price),
						styles: { halign: 'right', fontSize: 9 },
					},
					{
						content: currencyFormatter.format(item.priceWithoutVat),
						styles: { halign: 'right', fontSize: 9 },
					},
				]);
			}

			// VAT row
			tableRows.push([
				{
					content: `${t.vat} (${vatRateDisplay}%)`,
					colSpan: 3,
					styles: { fontStyle: 'italic', textColor: C.textMuted, fontSize: 9 },
				},
				{
					content: currencyFormatter.format(group.vatAmount),
					styles: {
						halign: 'right',
						fontStyle: 'italic',
						textColor: C.textMuted,
						fontSize: 9,
					},
				},
			]);

			// Subtotal row
			tableRows.push([
				{
					content: `${t.subtotal} (${vatRateDisplay}%)`,
					colSpan: 3,
					styles: { fontStyle: 'bold', fontSize: 9 },
				},
				{
					content: currencyFormatter.format(group.grossTotal),
					styles: { halign: 'right', fontStyle: 'bold', fontSize: 9 },
				},
			]);
		}

		autoTable(doc, {
			startY: y,
			margin: { left: ML, right: MR },
			head: [
				[
					{ content: t.description, styles: {} },
					{ content: t.quantity, styles: { halign: 'center' } },
					{ content: t.unitPrice, styles: { halign: 'right' } },
					{ content: t.totalNet, styles: { halign: 'right' } },
				],
			],
			body: tableRows,
			headStyles: {
				fillColor: C.primary,
				textColor: C.white,
				fontStyle: 'bold',
				fontSize: 8,
				cellPadding: 3,
			},
			bodyStyles: {
				fontSize: 9,
				cellPadding: 3,
				textColor: C.text,
			},
			columnStyles: {
				0: { cellWidth: 'auto' },
				1: { cellWidth: 24 },
				2: { cellWidth: 34 },
				3: { cellWidth: 34 },
			},
			theme: 'grid',
			styles: {
				lineColor: C.border,
				lineWidth: 0.3,
				font: 'helvetica',
			},
			tableLineColor: C.border,
			tableLineWidth: 0.3,
		});

		y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;

		// ── 6. Totals card ─────────────────────────────────────────────────
		const totals = invoiceGroups.reduce(
			(acc, group) => {
				acc.net += group.netTotal;
				acc.vat += group.vatAmount;
				acc.gross += group.grossTotal;
				return acc;
			},
			{ net: 0, vat: 0, gross: 0 },
		);

		const cardTotalW = 80;
		const cardTotalX = PAGE_W - MR - cardTotalW;
		let cardTotalH = 22;
		if (totals.vat > 0) cardTotalH += 6;

		y = ensureSpace(doc, y, cardTotalH + 4);

		doc.setFillColor(...C.totalsCardBg);
		doc.setDrawColor(...C.border);
		doc.setLineWidth(0.3);
		drawRoundedRect(doc, cardTotalX, y, cardTotalW, cardTotalH, 1.5, 'FD');

		let ty = y + 5;
		const labelX = cardTotalX + 4;
		const valX = cardTotalX + cardTotalW - 4;

		// Net total
		doc.setFontSize(8);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.textMuted);
		doc.text(t.netTotal.toUpperCase(), labelX, ty);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.text);
		doc.text(currencyFormatter.format(totals.net), valX, ty, { align: 'right' });
		ty += 5;

		// VAT (if > 0)
		if (totals.vat > 0) {
			doc.setFont('helvetica', 'bold');
			doc.setTextColor(...C.textMuted);
			doc.text(t.totalVat.toUpperCase(), labelX, ty);
			doc.setTextColor(...C.text);
			doc.text(currencyFormatter.format(totals.vat), valX, ty, { align: 'right' });
			ty += 5;
		}

		// Separator
		doc.setDrawColor(...C.primary);
		doc.setLineWidth(0.2);
		doc.line(labelX, ty - 2, valX, ty - 2);

		// Grand total
		doc.setFontSize(10);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.primary);
		doc.text(t.totalAmount.toUpperCase(), labelX, ty + 2);
		doc.text(currencyFormatter.format(totals.gross), valX, ty + 2, { align: 'right' });

		y += cardTotalH + 6;
	}

	// ── 7. Reverse charge notice ─────────────────────────────────────────
	if (options?.reverseCharge) {
		y = ensureSpace(doc, y, 14);
		const rcH = 10;
		doc.setFillColor(...C.warningBg);
		doc.setDrawColor(...C.warningBorder);
		doc.setLineWidth(0.4);
		drawRoundedRect(doc, ML, y, CONTENT_W, rcH, 2, 'FD');

		doc.setFontSize(8);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.warningText);
		const rcLines = doc.splitTextToSize(t.reverseChargeNotice, CONTENT_W - 10) as string[];
		doc.text(rcLines, ML + 5, y + 5);
		y += rcH + 4;
	}

	// ── 8. Closing + Signature ───────────────────────────────────────────
	if (closing) {
		y = ensureSpace(doc, y, 12);
		doc.setFontSize(10);
		doc.setFont('helvetica', 'italic');
		doc.setTextColor(...C.text);
		doc.text(closing, ML, y);
		y += 5;
	}
	if (signature) {
		doc.setFontSize(10);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.text);
		doc.text(signature, ML, y);
		y += 8;
	}

	// ── 9. Terms & Privacy ───────────────────────────────────────────────
	if (terms || privacy) {
		const LINE_H = 3.5;
		if (terms) {
			y = ensureSpace(doc, y, 8);
			doc.setFontSize(8);
			doc.setFont('helvetica', 'bold');
			doc.setTextColor(...C.primary);
			doc.text(t.termsAndConditions.toUpperCase(), ML, y);
			y += LINE_H;
			doc.setFont('helvetica', 'normal');
			doc.setTextColor(...C.textMuted);
			const termsLines = doc.splitTextToSize(terms, CONTENT_W) as string[];
			for (const line of termsLines) {
				y = ensureSpace(doc, y, LINE_H + 2);
				doc.text(line, ML, y);
				y += LINE_H;
			}
			y += 3;
		}
		if (privacy) {
			y = ensureSpace(doc, y, 8);
			doc.setFontSize(8);
			doc.setFont('helvetica', 'bold');
			doc.setTextColor(...C.primary);
			doc.text(t.privacyPolicy.toUpperCase(), ML, y);
			y += LINE_H;
			doc.setFont('helvetica', 'normal');
			doc.setTextColor(...C.textMuted);
			const privacyLines = doc.splitTextToSize(privacy, CONTENT_W) as string[];
			for (const line of privacyLines) {
				y = ensureSpace(doc, y, LINE_H + 2);
				doc.text(line, ML, y);
				y += LINE_H;
			}
			y += 3;
		}
	}

	// ── 10. CoinGecko attribution ────────────────────────────────────────
	if (includeCoingeckoAttribution) {
		y = ensureSpace(doc, y, 8);
		doc.setFontSize(8);
		doc.setFont('helvetica', 'normal');
		doc.setTextColor(...C.textMuted);
		doc.text(`${t.coingeckoAttribution} CoinGecko (coingecko.com)`, ML, y);
		y += 4;
	}

	// ── 10b. Conversion rates table ─────────────────────────────────────
	if (invoiceGroups.length > 0) {
		const conversionMap = new Map<
			string,
			{ convertedUnit: string; conversionFactor: number; decimals: number; conversionDate: Date }
		>();
		for (const group of invoiceGroups) {
			for (const item of group.items) {
				if (!conversionMap.has(item.convertedUnit)) {
					conversionMap.set(item.convertedUnit, {
						convertedUnit: item.convertedUnit,
						conversionFactor: item.conversionFactor,
						decimals: item.decimals,
						conversionDate: item.conversionDate,
					});
				}
			}
		}

		if (conversionMap.size > 0) {
			const conversionRows: RowInput[] = [];
			for (const conv of conversionMap.values()) {
				const assetName = formatCryptoUnitConversion(conv.convertedUnit, '').trim();
				const rateStr = `${currencyFormatter.format(1)} = ${formatCryptoUnitConversion(
					conv.convertedUnit,
					numberFormatter.format(conv.conversionFactor / 10 ** conv.decimals),
				)}`;
				conversionRows.push([
					{ content: assetName, styles: { fontSize: 8 } },
					{ content: rateStr, styles: { fontSize: 8 } },
					{ content: dateFormatter.format(conv.conversionDate), styles: { fontSize: 8 } },
				]);
			}

			autoTable(doc, {
				startY: y,
				margin: { left: ML, right: MR },
				head: [
					[
						{ content: t.conversionAsset, styles: {} },
						{ content: t.conversionRate, styles: {} },
						{ content: t.date, styles: {} },
					],
				],
				body: conversionRows,
				headStyles: {
					fillColor: C.textMuted,
					textColor: C.white,
					fontStyle: 'bold',
					fontSize: 7,
					cellPadding: 2,
				},
				bodyStyles: {
					fontSize: 8,
					cellPadding: 2,
					textColor: C.textMuted,
				},
				theme: 'grid',
				styles: {
					lineColor: C.border,
					lineWidth: 0.2,
					font: 'helvetica',
				},
				tableLineColor: C.border,
				tableLineWidth: 0.2,
			});

			y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;
		}
	}

	// ── 11. Footer on every page ─────────────────────────────────────────
	if (footer) {
		const totalPages = doc.getNumberOfPages();
		for (let i = 1; i <= totalPages; i++) {
			doc.setPage(i);
			doc.setDrawColor(...C.border);
			doc.setLineWidth(0.3);
			doc.line(ML, FOOTER_BOTTOM - 6, PAGE_W - MR, FOOTER_BOTTOM - 6);

			doc.setFontSize(8);
			doc.setFont('helvetica', 'normal');
			doc.setTextColor(...C.textMuted);
			doc.text(footer, PAGE_W / 2, FOOTER_BOTTOM - 2, { align: 'center' });
		}
	}

	// Suppress unused y warning
	void y;

	return doc;
}

// ── Exported API (same signatures as before) ───────────────────────────────

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
	options?: { invoiceType?: 'monthly'; isCancellation?: boolean; reverseCharge?: boolean; servicePeriod?: string },
): Promise<{ pdfBase64: string }> {
	try {
		const doc = buildInvoicePDF(
			invoiceConfig,
			seller,
			buyer,
			invoiceGroups,
			newInvoiceId,
			cancellationNotice,
			includeCoingeckoAttribution,
			options,
		);
		const arrayBuffer = doc.output('arraybuffer');
		const pdfBase64 = Buffer.from(arrayBuffer).toString('base64');
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
	options?: { invoiceType?: 'monthly'; isCancellation?: boolean; reverseCharge?: boolean; servicePeriod?: string },
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
	options?: { reverseCharge?: boolean; cancellationReason?: string },
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
	const baseDescription = texts.cancellationDefault(originalInvoiceNumber, originalInvoiceDate);
	const cancellationDescription = options?.cancellationReason
		? `${baseDescription}\n${texts.reason}: ${options.cancellationReason}`
		: baseDescription;
	const cancellationNotice = {
		cancellationTitle: texts.cancellationInvoice,
		cancellationDescription,
	};

	const doc = buildInvoicePDF(
		invoiceConfig,
		originalSeller,
		originalBuyer,
		negatedGroups,
		cancellationInvoiceId,
		cancellationNotice,
		includeCoingeckoAttribution,
		{ invoiceType: 'monthly', isCancellation: true, reverseCharge: options?.reverseCharge },
	);

	const arrayBuffer = doc.output('arraybuffer');
	const pdfBase64 = Buffer.from(arrayBuffer).toString('base64');
	return { pdfBase64 };
}
