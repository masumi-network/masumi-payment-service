import { formatCryptoUnitConversion } from './crypto-units';
import type { InvoiceBuyer, InvoiceGroup, InvoiceSeller, ResolvedInvoiceConfig } from './template';

export function generateInvoiceHTML(
	config: ResolvedInvoiceConfig,
	seller: InvoiceSeller,
	buyer: InvoiceBuyer,
	invoiceGroups: InvoiceGroup[],
	newInvoiceId: string,
	cancellationNotice: {
		cancellationTitle: string;
		cancellationDescription: string;
	} | null,
	includeCoingeckoAttribution: boolean = false,
	options?: { invoiceType?: 'monthly'; isCancellation?: boolean; reverseCharge?: boolean },
): string {
	const {
		title,
		description,
		date,
		greeting,
		closing,
		signature,
		logo,
		footer,
		terms,
		privacy,
		currencyFormatter,
		numberFormatter,
		dateFormatter,
		texts,
	} = config;

	const t = texts;
	const defaultInvoiceTitle = options?.isCancellation
		? t.cancellationInvoice
		: title || (options?.invoiceType === 'monthly' ? t.monthlyInvoice || t.invoice : t.invoice);

	// Group items by VAT rate and inclusion setting

	return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      --surface: #ffffff;
      --surface-muted: #f8fafc;
      --border: #e2e8f0;
      --border-strong: #e2e8f0;
      --primary: #1e293b;
      --primary-accent: #334155;
      --text: #334155;
      --text-muted: #64748b;
      --accent: #f1f5f9;
      --warning-bg: #fffbeb;
      --warning-border: #fcd34d;
      --warning-text: #92400e;
      --table-header-bg: #f1f5f9;
      --striped-row-bg: #f8fafc;
    }

    body {
      font-family: 'Arial', sans-serif;
      font-size: 12px;
      line-height: 1.6;
      color: var(--text);
      padding: 20px 12px;
    }

    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 36px 32px;
      min-height: 10in; /* fill A4 printable height (11in - 0.5in*2 margins) */
      display: flex;
      flex-direction: column;
      background: var(--surface);
      border-radius: 8px;
      border: 1px solid var(--border);
    }

    .header {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      align-items: flex-start;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 16px;
    }

    .logo {
      max-width: 200px;
      max-height: 80px;
      object-fit: contain;
      display: block;
    }

    .invoice-info {
      text-align: right;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 210px;
    }

    .invoice-meta {
      display: inline-flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .invoice-meta span {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
    }

    .invoice-meta strong {
      color: var(--text);
      font-weight: 600;
    }

    .invoice-title {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.2px;
      color: var(--primary);
      text-transform: uppercase;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 3px 8px;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      border-radius: 6px;
      background: var(--accent);
      color: var(--primary);
    }

    .parties {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 20px;
    }

    .party-card {
      padding: 12px 14px;
      border: none;
      border-left: 3px solid var(--border);
      background: var(--surface);
      display: grid;
      gap: 5px;
      font-size: 11px;
    }

    .party-card.party-from {
      border-left: none;
      border-right: 3px solid var(--border);
      text-align: right;
      margin-top: 8px;
    }

    .party-title {
      font-size: 10px;
      font-weight: 700;
      color: var(--primary);
      text-transform: uppercase;
      letter-spacing: 1.1px;
    }

    .party-info {
      display: flex;
      flex-direction: column;
      gap: 3px;
      color: var(--text);
      align-items: flex-start;
    }

    .party-info strong {
      font-size: 12px;
      font-weight: 600;
    }

    .party-info span {
      color: var(--text-muted);
    }

    .party-meta {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .party-meta span {
      display: inline-flex;
      gap: 4px;
      align-items: center;
    }

    .description-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 4px;
    }

    .greeting {
      margin-bottom: 12px;
      color: var(--text-muted);
      font-size: 12px;
    }

    .correction-notice {
      background: var(--warning-bg);
      border: 1px solid var(--warning-border);
      border-radius: 6px;
      padding: 12px 14px;
      margin: 8px 0;
      color: var(--warning-text);
      display: grid;
      gap: 4px;
    }

    .correction-title {
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 1.05px;
      text-transform: uppercase;
    }

    .correction-details {
      font-size: 10px;
      line-height: 1.15;
    }

    .table-wrapper {
      overflow: hidden;
      border-radius: 6px;
      border: 1px solid var(--border);

      margin-bottom: 20px;
      background: var(--surface);
    }

    .items-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    /* Numeric alignment helpers */
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .col-unit-price,
    .col-total-net {
      width: 18%;
    }

    .items-table thead tr {
      background: var(--table-header-bg);
      color: var(--text);
    }

    .items-table th {
      padding: 10px 12px;
      text-align: left;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    .items-table td {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      color: var(--text);
    }

    .items-table tbody tr:nth-child(even) {
      background: var(--striped-row-bg);
    }

    .vat-category-header td {
      background: transparent;
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--primary);
      border-top: 1px solid var(--border);
    }

    .vat-category-subtotal td {
      background: transparent;
      font-weight: 600;
      border-top: 1px solid var(--border);
    }

    .vat-row td {
      font-style: italic;
      color: var(--text-muted);
      background: transparent;
    }

    .text-right {
      text-align: right;
    }

    .text-center {
      text-align: center;
    }

    .total-section {
      margin-left: auto;
      max-width: 260px;
      margin-bottom: 12px;
    }

    .totals-card {
      padding: 12px 0;
      border: none;
      background: transparent;
      display: grid;
      gap: 8px;
    }

    .total-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--text);
      font-size: 11px;
      gap: 4px;
    }

    .total-row.final {
      font-weight: 700;
      font-size: 13px;
      color: var(--primary);
      padding-top: 8px;
      border-top: 1px solid var(--border);
    }

    .total-label {
      letter-spacing: 0.4px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
    }

    .total-value {
      font-weight: 600;
      color: var(--text);
    }

    .closing {
      margin-top: 24px;
      font-style: italic;
      color: var(--text);
    }

    .signature {
      margin-top: 8px;
      font-weight: 600;
      color: var(--text);
    }

    .coingecko-green {
      color: rgb(75, 204, 0);
      font-weight: 600;
    }

    .terms-section {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      color: var(--text);
      font-size: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }

    .terms-col {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .terms-title, .privacy-title {
      text-transform: uppercase;
      color: var(--primary);
      font-weight: 700;
      letter-spacing: 1px;
      font-size: 9px;
    }

    .terms-text, .privacy-text {
      color: var(--text-muted);
      font-size: 10px;
      line-height: 1.4;
    }

    .v-line {
      border-top: 1px solid var(--border);
    }

    .footer {
      margin-top: auto; /* push footer to bottom when content is short */
      padding-top: 14px;
      font-size: 10px;
      color: var(--text-muted);
      text-align: center;
    }

    .coingecko-link {
        color: rgb(75, 204, 0);
        text-decoration: underline;
        display: inline-flex;
        align-items: center;
        font-weight: 500;
    }

    .coingecko-icon {
        margin-left: 2px;
        margin-bottom: 4px;
        width: 12px;
        height: 12px;
        stroke: currentColor;
        fill: none;
    }

    .attribution {
     margin-top: 12px;
     display: flex;
     justify-content: flex-start;
     align-items: flex-start;
    }

    @media print {
      body {
        background: #fff;
        padding: 0;
        font-size: 11px;
      }

      .container {
        border-radius: 0;
        border: none;
        padding: 18px 20px;
      }

      .table-wrapper {
        box-shadow: none;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div class="logo-section">
        ${logo ? `<img src="${logo}" alt="Company Logo" class="logo">` : ''}
      </div>
      <div class="invoice-info">
        <div class="invoice-title">${defaultInvoiceTitle}</div>
        <div class="invoice-meta">
          <span>${t.invoiceNumber}: <strong>${newInvoiceId}</strong></span>
          <span>${t.date}: <strong>${dateFormatter.format(date)}</strong></span>
          ${cancellationNotice ? `<span class="badge">${t.cancellationInvoice}</span>` : ''}
        </div>
      </div>
    </div>

    <!-- Parties (To then From, stacked) -->
    <div class="parties">
      <!-- To (Buyer) -->
      <div class="party-card">
        <div class="party-title">${t.to}</div>
        <div class="party-info">
          ${buyer.companyName ? `<strong>${buyer.companyName}</strong>` : ''}
          ${buyer.name ? `<span>${buyer.name}</span>` : ''}
          <span>${buyer.street} ${buyer.streetNumber}</span>
          <span>${buyer.zipCode} ${buyer.city}</span>
          <span>${buyer.country}</span>
          <div class="party-meta">
            ${buyer.email ? `<span>${t.email}: ${buyer.email}</span>` : ''}
            ${buyer.phone ? `<span>${t.phone}: ${buyer.phone}</span>` : ''}
            ${buyer.vatNumber ? `<span>${t.vat}: ${buyer.vatNumber}</span>` : ''}
          </div>
        </div>
      </div>

      <!-- From (Seller) -->
      <div class="party-card party-from">
        <div class="party-title">${t.from}</div>
        <div class="party-info">
          ${seller.companyName ? `<strong>${seller.companyName}</strong>` : ''}
          ${seller.name ? `<span>${seller.name}</span>` : ''}
          <span>${seller.street} ${seller.streetNumber}</span>
          <span>${seller.zipCode} ${seller.city}</span>
          <span>${seller.country}</span>
          <div class="party-meta">
            ${seller.email ? `<span>${t.email}: ${seller.email}</span>` : ''}
            ${seller.phone ? `<span>${t.phone}: ${seller.phone}</span>` : ''}
            ${seller.vatNumber ? `<span>${t.vat}: ${seller.vatNumber}</span>` : ''}
          </div>
        </div>
      </div>
    </div>

    <!-- Cancellation Invoice Notice -->
    ${
			cancellationNotice
				? `
    <div class="correction-notice">
      <div class="correction-title">${cancellationNotice.cancellationTitle}</div>
      <div class="correction-details">
        ${cancellationNotice.cancellationDescription}
      </div>
    </div>
    `
				: ''
		}

    <!-- Description + Greeting -->
    ${description ? `<div class="description-title">${description}</div>` : ''}
    ${greeting ? `<div class="greeting">${greeting}</div>` : ''}

    <!-- Items Table -->
    ${
			invoiceGroups.length > 0
				? `
    <div class="table-wrapper">
      <table class="items-table">
        <thead>
          <tr>
            <th>${t.description}</th>
            <th class="text-center">${t.quantity}</th>
            <th class="text-right num col-unit-price">${t.unitPrice}</th>
            <th class="text-right num col-total-net">${t.totalNet}</th>
          </tr>
        </thead>
        <tbody>
          ${Array.from(invoiceGroups.values())
						.map((group) => {
							const vatRateDisplay = numberFormatter.format(group.vatRate * 100);

							return `

          ${group.items
						.map((item) => {
							const netUnitPrice = item.price;
							const netAmount = item.priceWithoutVat || 0;
							return `
          <tr>
            <td>${item.name}</td>
            <td class="text-center">${item.quantity}</td>
            <td class="text-right num col-unit-price">${currencyFormatter.format(netUnitPrice)}</td>
            <td class="text-right num col-total-net">${currencyFormatter.format(netAmount)}</td>
          </tr>
          `;
						})
						.join('')}

          <tr class="vat-row">
            <td colspan="3"><strong>${t.vat} (${vatRateDisplay}%)</strong></td>
            <td class="text-right"><strong>${currencyFormatter.format(group.vatAmount)}</strong></td>
          </tr>

          <tr class="vat-category-subtotal">
            <td colspan="3"><strong>${t.subtotal} (${vatRateDisplay}%)</strong></td>
            <td class="text-right"><strong>${currencyFormatter.format(group.grossTotal)}</strong></td>
          </tr>
          `;
						})
						.join('')}
        </tbody>
      </table>
    </div>

    <!-- Total Section -->
    <div class="total-section">
      ${(() => {
				const totals = invoiceGroups.reduce(
					(acc, group) => {
						acc.net += group.netTotal;
						acc.vat += group.vatAmount;
						acc.gross += group.grossTotal;
						return acc;
					},
					{ net: 0, vat: 0, gross: 0 },
				);

				return `

      <div class="totals-card">
        <div class="total-row">
          <span class="total-label">${t.netTotal} </span>
          <span class="total-value">${currencyFormatter.format(totals.net)}</span>
        </div>
        ${
					totals.vat > 0
						? `
        <div class="total-row">
          <span class="total-label">${t.totalVat} </span>
          <span class="total-value">${currencyFormatter.format(totals.vat)}</span>
        </div>
        `
						: ''
				}
        <div class="total-row final">
          <span class="total-label">${t.totalAmount} </span>
          <span class="total-value">${currencyFormatter.format(totals.gross)}</span>
        </div>
      </div>
      `;
			})()}
    </div>
    `
				: ''
		}

    ${options?.reverseCharge ? `<div class="correction-notice" style="margin-bottom: 12px;"><div class="correction-title">${t.reverseChargeNotice}</div></div>` : ''}
    ${closing ? `<div class="closing">${closing}</div>` : ''}
    ${signature ? `<div class="signature">${signature}</div>` : ''}

    ${includeCoingeckoAttribution ? `<div class="attribution"><span>${t.coingeckoAttribution} <span class="coingecko-green">CoinGecko</span> (coingecko.com)</span></div>` : ''}
    ${(() => {
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
			if (conversionMap.size === 0) return '';
			return `
    <div class="table-wrapper" style="margin-top: 8px; margin-bottom: 0;">
      <table class="items-table" style="font-size: 11px;">
        <thead>
          <tr>
            <th>${t.conversionAsset}</th>
            <th>${t.conversionRate}</th>
            <th>${t.date}</th>
          </tr>
        </thead>
        <tbody>
          ${Array.from(conversionMap.values())
						.map((conv) => {
							const assetName = formatCryptoUnitConversion(conv.convertedUnit, '').trim();
							const rateStr = `${currencyFormatter.format(1)} = ${formatCryptoUnitConversion(conv.convertedUnit, numberFormatter.format(conv.conversionFactor / 10 ** conv.decimals))}`;
							return `
          <tr>
            <td>${assetName}</td>
            <td>${rateStr}</td>
            <td>${dateFormatter.format(conv.conversionDate)}</td>
          </tr>`;
						})
						.join('')}
        </tbody>
      </table>
    </div>`;
		})()}

    <!-- Footer area: terms & privacy side by side, then footer text -->
    ${
			terms || privacy
				? `
    <div class="terms-section" style="margin-top: auto;">
      ${terms ? `<div class="terms-col"><div class="terms-title">${t.termsAndConditions}</div><div class="terms-text">${terms}</div></div>` : ''}
      ${privacy ? `<div class="terms-col"><div class="privacy-title">${t.privacyPolicy}</div><div class="privacy-text">${privacy}</div></div>` : ''}
    </div>
    `
				: ''
		}
    ${footer ? `${!terms && !privacy ? '<div class="v-line" style="margin-top:auto;"></div>' : ''}` : ''}
    ${footer ? `<div class="footer">${footer}</div>` : ''}

  </div>
</body>
</html>
  `.trim();
}
