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

// ── Colors (slate gray palette) ───────────────────────────────────────────
const C = {
	primary: [30, 41, 59] as [number, number, number], // #1e293b – Slate 800
	text: [51, 65, 85] as [number, number, number], // #334155 – Slate 700
	textMuted: [100, 116, 139] as [number, number, number], // #64748b – Slate 500
	border: [226, 232, 240] as [number, number, number], // #e2e8f0 – Slate 200
	white: [255, 255, 255] as [number, number, number],
	warningBg: [255, 251, 235] as [number, number, number], // #fffbeb – Amber 50
	warningBorder: [252, 211, 77] as [number, number, number], // #fcd34d – Amber 300
	warningText: [146, 64, 14] as [number, number, number], // #92400e – Amber 800
	tableHeaderBg: [241, 245, 249] as [number, number, number], // #f1f5f9 – Slate 100
	stripedRowBg: [248, 250, 252] as [number, number, number], // #f8fafc – Slate 50
};

// ── Layout constants (mm) ──────────────────────────────────────────────────
const PAGE_W = 210;
const PAGE_H = 297;
const ML = 18; // margin left
const MR = 18; // margin right
const MT = 18; // margin top
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
		description,
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
	doc.setLineWidth(0.2);
	doc.line(ML, y, PAGE_W - MR, y);
	y += 10;

	// ── 2. Party cards (To left with bar, From right-aligned below) ─────
	const partyGap = 10;
	const partyCardW = (CONTENT_W - partyGap) / 2;
	const toX = ML;
	const fromX = ML + partyCardW + partyGap;

	const drawPartyCard = (
		targetDoc: jsPDF,
		x: number,
		startY: number,
		label: string,
		party: InvoiceSeller | InvoiceBuyer,
		align: 'left' | 'right' = 'left',
	): number => {
		let cy = startY + 2;
		const innerX = align === 'right' ? x + partyCardW - 3 : x + 3;
		const textAlign = align === 'right' ? ('right' as const) : ('left' as const);

		// Label
		targetDoc.setFontSize(8);
		targetDoc.setFont('helvetica', 'bold');
		targetDoc.setTextColor(...C.primary);
		targetDoc.text(label.toUpperCase(), innerX, cy, { align: textAlign });
		cy += 5;

		// Company name
		if (party.companyName) {
			targetDoc.setFontSize(10);
			targetDoc.setFont('helvetica', 'bold');
			targetDoc.setTextColor(...C.text);
			targetDoc.text(party.companyName, innerX, cy, { align: textAlign });
			cy += 5;
		}

		// Name
		targetDoc.setFontSize(9);
		targetDoc.setFont('helvetica', 'normal');
		targetDoc.setTextColor(...C.text);
		if (party.name) {
			targetDoc.text(party.name, innerX, cy, { align: textAlign });
			cy += 4;
		}

		// Address
		targetDoc.setTextColor(...C.textMuted);
		targetDoc.text(`${party.street} ${party.streetNumber}`, innerX, cy, { align: textAlign });
		cy += 4;
		targetDoc.text(`${party.zipCode} ${party.city}`, innerX, cy, { align: textAlign });
		cy += 4;
		targetDoc.text(party.country, innerX, cy, { align: textAlign });
		cy += 5;

		// Meta (email, phone, VAT) — handle text overflow
		targetDoc.setFontSize(8);
		const metaParts: string[] = [];
		if (party.email) metaParts.push(`${t.email}: ${party.email}`);
		if (party.phone) metaParts.push(`${t.phone}: ${party.phone}`);
		if (party.vatNumber) metaParts.push(`${t.vat}: ${party.vatNumber}`);
		if (metaParts.length > 0) {
			const metaText = metaParts.join('  |  ');
			const metaLines = targetDoc.splitTextToSize(metaText, partyCardW - 8) as string[];
			for (const line of metaLines) {
				targetDoc.text(line, innerX, cy, { align: textAlign });
				cy += 3.5;
			}
		}

		return cy + 2;
	};

	// Draw "To" (buyer) — left-aligned with left border accent
	const tempDoc = new jsPDF({ unit: 'mm', format: 'a4' });
	const barOvershoot = 2; // extend bar above/below content for centering
	const toStartY = y;
	const toBottom = drawPartyCard(tempDoc, toX, toStartY, t.to, buyer) - toStartY;

	doc.setDrawColor(...C.border);
	doc.setLineWidth(0.7);
	doc.line(toX, toStartY - barOvershoot, toX, toStartY + toBottom + 2 + barOvershoot);

	drawPartyCard(doc, toX, toStartY, t.to, buyer);

	// Draw "From" (seller) — starts at 70% down the To block, right-aligned
	const fromStartY = toStartY + Math.round(toBottom * 0.7);
	const fromBottom = drawPartyCard(tempDoc, fromX, fromStartY, t.from, seller, 'right') - fromStartY;

	doc.setDrawColor(...C.border);
	doc.setLineWidth(0.7);
	doc.line(PAGE_W - MR, fromStartY - barOvershoot, PAGE_W - MR, fromStartY + fromBottom + 2 + barOvershoot);

	drawPartyCard(doc, fromX, fromStartY, t.from, seller, 'right');

	// Advance y past whichever block ends lower
	y = Math.max(toStartY + toBottom, fromStartY + fromBottom) + 8;

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

		y += noticeH + 6;
	}

	// ── 4. Description + Greeting ───────────────────────────────────────
	if (description) {
		y = ensureSpace(doc, y, 12);
		doc.setFontSize(11);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.primary);
		doc.text(description, ML, y);
		y += 6;
	}
	if (greeting) {
		y = ensureSpace(doc, y, 10);
		doc.setFontSize(10);
		doc.setFont('helvetica', 'normal');
		doc.setTextColor(...C.textMuted);
		doc.text(greeting, ML, y);
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
				fillColor: C.tableHeaderBg,
				textColor: C.text,
				fontStyle: 'bold',
				fontSize: 8,
				cellPadding: 4,
			},
			bodyStyles: {
				fontSize: 9,
				cellPadding: 4,
				textColor: C.text,
			},
			alternateRowStyles: {
				fillColor: C.stripedRowBg,
			},
			columnStyles: {
				0: { cellWidth: 'auto' },
				1: { cellWidth: 24 },
				2: { cellWidth: 34 },
				3: { cellWidth: 34 },
			},
			theme: 'striped',
			styles: {
				lineColor: C.border,
				lineWidth: 0.2,
				font: 'helvetica',
			},
			tableLineColor: C.border,
			tableLineWidth: 0.2,
		});

		y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;

		// ── 6. Totals section ──────────────────────────────────────────────
		const totals = invoiceGroups.reduce(
			(acc, group) => {
				acc.net += group.netTotal;
				acc.vat += group.vatAmount;
				acc.gross += group.grossTotal;
				return acc;
			},
			{ net: 0, vat: 0, gross: 0 },
		);

		const totalW = 80;
		const labelX = PAGE_W - MR - totalW;
		const valX = PAGE_W - MR;
		let totalH = 24;
		if (totals.vat > 0) totalH += 7;

		y = ensureSpace(doc, y, totalH + 4);

		let ty = y;

		// Net total
		doc.setFontSize(8);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.textMuted);
		doc.text(t.netTotal.toUpperCase(), labelX, ty);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.text);
		doc.text(currencyFormatter.format(totals.net), valX, ty, { align: 'right' });
		ty += 6;

		// VAT (if > 0)
		if (totals.vat > 0) {
			doc.setFont('helvetica', 'bold');
			doc.setTextColor(...C.textMuted);
			doc.text(t.totalVat.toUpperCase(), labelX, ty);
			doc.setTextColor(...C.text);
			doc.text(currencyFormatter.format(totals.vat), valX, ty, { align: 'right' });
			ty += 7;
		}

		// Separator — thin top border for total
		doc.setDrawColor(...C.border);
		doc.setLineWidth(0.3);
		doc.line(labelX, ty - 2, valX, ty - 2);

		// Grand total
		doc.setFontSize(10);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.primary);
		doc.text(t.totalAmount.toUpperCase(), labelX, ty + 2);
		doc.text(currencyFormatter.format(totals.gross), valX, ty + 2, { align: 'right' });

		y += totalH + 8;
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
		y += rcH + 6;
	}

	// ── 8. Closing + Signature ───────────────────────────────────────────
	if (closing) {
		y += 4; // extra breathing room before closing
		y = ensureSpace(doc, y, 16);
		doc.setFontSize(10);
		doc.setFont('helvetica', 'italic');
		doc.setTextColor(...C.text);
		doc.text(closing, ML, y);
		y += 6;
	}
	if (signature) {
		doc.setFontSize(10);
		doc.setFont('helvetica', 'bold');
		doc.setTextColor(...C.text);
		doc.text(signature, ML, y);
		y += 8;
	}

	// ── 9. CoinGecko attribution ────────────────────────────────────────
	if (includeCoingeckoAttribution) {
		y = ensureSpace(doc, y, 8);
		doc.setFontSize(8);
		doc.setFont('helvetica', 'normal');
		doc.setTextColor(...C.textMuted);
		doc.text(`${t.coingeckoAttribution} `, ML, y);
		const attrWidth = doc.getTextWidth(`${t.coingeckoAttribution} `);
		doc.setTextColor(75, 204, 0); // CoinGecko green
		doc.setFont('helvetica', 'bold');
		doc.text('CoinGecko', ML + attrWidth, y);
		const cgWidth = doc.getTextWidth('CoinGecko');
		doc.setFont('helvetica', 'normal');
		doc.setTextColor(...C.textMuted);
		doc.text(' (coingecko.com)', ML + attrWidth + cgWidth, y);
		y += 4;
	}

	// ── 10. Conversion rates table ──────────────────────────────────────
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
					fillColor: C.tableHeaderBg,
					textColor: C.text,
					fontStyle: 'bold',
					fontSize: 7,
					cellPadding: 3,
				},
				bodyStyles: {
					fontSize: 8,
					cellPadding: 3,
					textColor: C.text,
				},
				alternateRowStyles: {
					fillColor: C.stripedRowBg,
				},
				theme: 'striped',
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

	// ── 11. Terms & Privacy (inline, side by side) ─────────────────────
	y += 12; // top margin before terms
	if (terms || privacy) {
		const LINE_H = 3;
		const colW = (CONTENT_W - 6) / 2;

		doc.setFontSize(7);
		doc.setFont('helvetica', 'normal');
		const termsLines = terms ? (doc.splitTextToSize(terms, colW) as string[]) : [];
		const privacyLines = privacy ? (doc.splitTextToSize(privacy, colW) as string[]) : [];
		const termsH = terms ? 4 + termsLines.length * LINE_H : 0;
		const privacyH = privacy ? 4 + privacyLines.length * LINE_H : 0;
		const legalH = Math.max(termsH, privacyH);

		y = ensureSpace(doc, y, legalH + 6);

		// Separator line
		doc.setDrawColor(...C.border);
		doc.setLineWidth(0.3);
		doc.line(ML, y, PAGE_W - MR, y);
		y += 5;

		const leftX = ML;
		const rightX = ML + colW + 6;

		if (terms) {
			doc.setFontSize(7);
			doc.setFont('helvetica', 'bold');
			doc.setTextColor(...C.primary);
			doc.text(t.termsAndConditions.toUpperCase(), leftX, y);
			doc.setFont('helvetica', 'normal');
			doc.setTextColor(...C.textMuted);
			let ty = y + LINE_H;
			for (const line of termsLines) {
				doc.text(line, leftX, ty);
				ty += LINE_H;
			}
		}

		if (privacy) {
			doc.setFontSize(7);
			doc.setFont('helvetica', 'bold');
			doc.setTextColor(...C.primary);
			doc.text(t.privacyPolicy.toUpperCase(), rightX, y);
			doc.setFont('helvetica', 'normal');
			doc.setTextColor(...C.textMuted);
			let py = y + LINE_H;
			for (const line of privacyLines) {
				doc.text(line, rightX, py);
				py += LINE_H;
			}
		}

		y += legalH + 4;
	}

	// ── 12. Footer on every page ────────────────────────────────────────
	if (footer) {
		const totalPages = doc.getNumberOfPages();
		for (let i = 1; i <= totalPages; i++) {
			doc.setPage(i);
			doc.setDrawColor(...C.border);
			doc.setLineWidth(0.3);
			doc.line(ML, FOOTER_BOTTOM - 4, PAGE_W - MR, FOOTER_BOTTOM - 4);
			doc.setFontSize(7);
			doc.setFont('helvetica', 'normal');
			doc.setTextColor(...C.textMuted);
			doc.text(footer, PAGE_W / 2, FOOTER_BOTTOM, { align: 'center' });
		}
	}

	// Suppress unused y warning
	void y;

	return doc;
}

// ── Exported API (same signatures as before) ───────────────────────────────

async function generateInvoicePDF(
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
