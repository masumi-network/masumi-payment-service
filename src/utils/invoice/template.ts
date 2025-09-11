import { z } from 'zod';
import { postGenerateInvoiceSchemaInput } from '@/routes/api/invoice/index';
import { generateHash } from '../crypto';

type InvoiceData = z.infer<typeof postGenerateInvoiceSchemaInput>;
function generateInvoiceId(): string {
  const randomData = crypto.randomUUID();
  const randomHash = generateHash(randomData);
  //replace all non-numbers with their ASCII code
  const numberHash = randomHash.replace(/[^0-9]/g, (char) =>
    (char.charCodeAt(0) % 10).toString(),
  );
  const randomHashShort = `${numberHash.slice(0, 4)}-${numberHash.slice(4, 8)}-${numberHash.slice(8, 12)}-${numberHash.slice(12, 16)}`;
  return randomHashShort;
}
interface VATGroup {
  vatRate: number;
  vatIsIncluded: boolean;
  items: Array<NonNullable<InvoiceData['invoiceItems']>[0]>;
  netTotal: number;
  vatAmount: number;
  grossTotal: number;
}

// Language and region-specific configuration
const LOCALE_CONFIG = {
  'en-us': {
    texts: {
      invoice: 'Invoice',
      correction: 'Correction',
      correctionInvoice: 'CORRECTION INVOICE',
      correctionDefault: (invoiceNumber: string, invoiceDate: string) =>
        `This invoice corrects the original invoice #${invoiceNumber} dated ${invoiceDate}.`,
      reason: 'Reason',
      from: 'From',
      to: 'To',
      description: 'Description',
      quantity: 'Quantity',
      unitPrice: 'Unit Price (Net)',
      totalNet: 'Total (Net)',
      vatRate: 'VAT Rate',
      netTotal: 'Net Total',
      totalVat: 'Total VAT',
      totalAmount: 'Total Amount',
      subtotal: 'Subtotal',
      vat: 'VAT',
      date: 'Date',
      invoiceNumber: 'Invoice #',
      email: 'Email',
      phone: 'Phone',
      termsAndConditions: 'Terms and Conditions',
      privacyPolicy: 'Privacy Policy',
    },
    defaultThousandDelimiter: ',',
    defaultDecimalDelimiter: '.',
    defaultDateFormat: 'MM/DD/YYYY',
  },
  'en-uk': {
    texts: {
      invoice: 'Invoice',
      correction: 'Correction',
      correctionInvoice: 'CORRECTION INVOICE',
      correctionDefault: (invoiceNumber: string, invoiceDate: string) =>
        `This invoice corrects the original invoice #${invoiceNumber} dated ${invoiceDate}.`,
      reason: 'Reason',
      from: 'From',
      to: 'To',
      description: 'Description',
      quantity: 'Quantity',
      unitPrice: 'Unit Price (Net)',
      totalNet: 'Total (Net)',
      vatRate: 'VAT Rate',
      netTotal: 'Net Total',
      totalVat: 'Total VAT',
      totalAmount: 'Total Amount',
      subtotal: 'Subtotal',
      vat: 'VAT',
      date: 'Date',
      invoiceNumber: 'Invoice #',
      email: 'Email',
      phone: 'Phone',
      termsAndConditions: 'Terms and Conditions',
      privacyPolicy: 'Privacy Policy',
    },
    defaultThousandDelimiter: ',',
    defaultDecimalDelimiter: '.',
    defaultDateFormat: 'DD/MM/YYYY',
  },
  de: {
    texts: {
      invoice: 'Rechnung',
      correction: 'Korrektur',
      correctionInvoice: 'KORREKTURRECHNUNG',
      correctionDefault: (invoiceNumber: string, invoiceDate: string) =>
        `Diese Rechnung korrigiert die ursprüngliche Rechnung #${invoiceNumber} vom ${invoiceDate}.`,
      reason: 'Grund',
      from: 'Von',
      to: 'An',
      description: 'Beschreibung',
      quantity: 'Menge',
      unitPrice: 'Einzelpreis (Netto)',
      totalNet: 'Gesamt (Netto)',
      vatRate: 'MwSt.-Satz',
      netTotal: 'Nettosumme',
      totalVat: 'Gesamte MwSt.',
      totalAmount: 'Gesamtbetrag',
      subtotal: 'Zwischensumme',
      vat: 'MwSt.',
      date: 'Datum',
      invoiceNumber: 'Rechnung Nr.',
      email: 'E-Mail',
      phone: 'Telefon',
      termsAndConditions: 'Allgemeine Geschäftsbedingungen',
      privacyPolicy: 'Datenschutzerklärung',
    },
    defaultThousandDelimiter: '.',
    defaultDecimalDelimiter: ',',
    defaultDateFormat: 'DD.MM.YYYY',
  },
} as const;

export function generateInvoiceHTML(data: InvoiceData): string {
  const {
    seller,
    buyer,
    invoiceTitle,
    invoiceDate = new Date().toLocaleDateString(),
    invoiceItems = [],
    invoiceGreetings,
    invoiceClosing,
    invoiceSignature,
    invoiceLogo,
    invoiceFooter,
    invoiceTerms,
    invoicePrivacy,
    correctionInvoiceReference,
    vatRate = 0,
    vatIsIncludedInThePrice = false,
    decimals = 2,
    currency: globalCurrency,
    thousandDelimiter,
    decimalDelimiter = '.',
    language = 'en-us',
    dateFormat,
  } = data;

  // Get locale configuration
  const locale = LOCALE_CONFIG[language];
  const t = locale.texts;
  const defaultInvoiceTitle = invoiceTitle || t.invoice;

  // Determine delimiters with language defaults
  const useThousandDelimiter =
    thousandDelimiter ?? locale.defaultThousandDelimiter;
  const useDecimalDelimiter =
    decimalDelimiter ?? locale.defaultDecimalDelimiter;
  const useDateFormat = dateFormat ?? locale.defaultDateFormat;

  const usedInvoiceNumber = data.invoiceNumber ?? generateInvoiceId();

  // Group items by VAT rate and inclusion setting
  const vatGroups = new Map<string, VATGroup>();

  invoiceItems.forEach((item) => {
    const itemVatRate = item.vatRateOverride ?? vatRate;
    const itemVatIsIncluded =
      item.vatIsIncludedInThePriceOverride ?? vatIsIncludedInThePrice;
    const groupKey = `${itemVatRate}`; // Group only by VAT rate

    if (!vatGroups.has(groupKey)) {
      vatGroups.set(groupKey, {
        vatRate: itemVatRate,
        vatIsIncluded: false, // Always treat as net prices in display
        items: [],
        netTotal: 0,
        vatAmount: 0,
        grossTotal: 0,
      });
    }

    const group = vatGroups.get(groupKey)!;

    // Store the original item with its inclusion setting for display logic
    const itemWithInclusion = {
      ...item,
      vatIsIncludedInThePriceOverride: itemVatIsIncluded,
    };
    group.items.push(itemWithInclusion);

    const itemTotal = item.quantity * item.price;

    if (itemVatIsIncluded) {
      // VAT is included in price - extract net amount
      const netAmount = itemTotal / (1 + itemVatRate);
      const vatAmount = itemTotal - netAmount;
      group.netTotal += netAmount;
      group.vatAmount += vatAmount;
      group.grossTotal += itemTotal;
    } else {
      // VAT is not included - price is net amount
      const vatAmount = itemTotal * itemVatRate;
      group.netTotal += itemTotal;
      group.vatAmount += vatAmount;
      group.grossTotal += itemTotal + vatAmount;
    }
  });

  // Calculate totals
  let totalNet = 0;
  let totalVat = 0;
  let totalGross = 0;

  vatGroups.forEach((group) => {
    totalNet += group.netTotal;
    totalVat += group.vatAmount;
    totalGross += group.grossTotal;
  });

  // Determine default currency
  const defaultCurrency = globalCurrency || invoiceItems[0]?.currency || 'USD';

  // Helper function to format dates
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear().toString();

    return useDateFormat
      .replace('DD', day)
      .replace('MM', month)
      .replace('YYYY', year);
  };

  // Helper function to format amounts
  const formatAmount = (
    amount: number,
    itemDecimals?: number,
    itemCurrency?: string,
  ) => {
    const useDecimals = itemDecimals ?? decimals;
    const useCurrency = itemCurrency || defaultCurrency;

    // Custom delimiter formatting using language defaults
    const numStr = amount.toFixed(useDecimals);
    const [integerPart, decimalPart] = numStr.split('.');

    // Apply thousand delimiter
    const formattedInteger = integerPart.replace(
      /\B(?=(\d{3})+(?!\d))/g,
      useThousandDelimiter === ' ' ? ' ' : useThousandDelimiter,
    );

    // Combine with decimal delimiter
    const formattedNum = decimalPart
      ? `${formattedInteger}${useDecimalDelimiter}${decimalPart}`
      : formattedInteger;

    return `${formattedNum} ${useCurrency}`;
  };

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${invoiceTitle}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Arial', sans-serif;
      font-size: 12px;
      line-height: 1.6;
      color: #333;
      background: #fff;
    }
    
    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }
    
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #e0e0e0;
    }
    
    .logo {
      max-width: 200px;
      max-height: 80px;
    }
    
    .invoice-info {
      text-align: right;
    }
    
    .invoice-title {
      font-size: 24px;
      font-weight: bold;
      color: #2c3e50;
      margin-bottom: 10px;
    }
    
    .invoice-details {
      font-size: 14px;
    }
    
    .parties {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 40px;
    }
    
    .party {
      margin-bottom: 0;
      width: 40%;
    }
    
    .party-from {
      text-align: right;
      margin-top: 5px;
      padding-bottom: 30px;
    }
    
    .party-to {
      text-align: left;
    }
    
    .party-title {
      font-size: 12px;
      font-weight: bold;
      color: #666;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .party-info {
      font-size: 13px;
      line-height: 1.4;
      color: #333;
    }
    
    .company-name {
      font-weight: bold;
      font-size: 14px;
      margin-bottom: 4px;
    }
    
    .person-name {
      font-size: 13px;
      margin-bottom: 4px;
    }
    
    .greeting {
      margin-bottom: 20px;
      font-style: italic;
      color: #555;
    }
    
    .correction-notice {
      background: #fff3cd;
      border: 2px solid #ffc107;
      border-radius: 5px;
      padding: 15px;
      margin: 20px 0;
      color: #856404;
    }
    
    .correction-title {
      font-weight: bold;
      font-size: 14px;
      margin-bottom: 8px;
      color: #856404;
    }
    
    .correction-details {
      font-size: 12px;
      line-height: 1.4;
    }
    
    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    
    .items-table th {
      background: #f8f9fa;
      color: #2c3e50;
      font-weight: bold;
      padding: 12px 8px;
      text-align: left;
      border-bottom: 2px solid #e0e0e0;
    }
    
    .items-table td {
      padding: 10px 8px;
      border-bottom: 1px solid #e0e0e0;
    }
    
    .items-table tr:nth-child(even) {
      background: #f8f9fa;
    }
    
    .vat-category-header {
      background: #e9ecef !important;
      border-top: 2px solid #2c3e50;
    }
    
    .vat-category-header td {
      padding: 12px 8px !important;
      font-size: 13px;
      color: #2c3e50;
    }
    
    .vat-category-subtotal {
      background: #f1f3f4 !important;
      border-bottom: 2px solid #e0e0e0;
    }
    
    .vat-category-subtotal td {
      padding: 10px 8px !important;
      font-size: 12px;
    }
    
    .vat-row {
      background: #f8f9fa !important;
    }
    
    .vat-row td {
      padding: 8px 8px !important;
      font-size: 12px;
      font-style: italic;
    }
    
    .text-right {
      text-align: right;
    }
    
    .text-center {
      text-align: center;
    }
    
    .total-section {
      margin-left: auto;
      width: 300px;
      margin-bottom: 30px;
    }
    
    .total-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #e0e0e0;
    }
    
    .total-row.final {
      font-weight: bold;
      font-size: 14px;
      border-bottom: 2px solid #2c3e50;
      color: #2c3e50;
    }
    
    .closing {
      margin-bottom: 20px;
      color: #555;
    }
    
    .signature {
      margin-bottom: 30px;
      text-align: right;
    }
    
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
      font-size: 10px;
      color: #666;
      text-align: center;
    }
    
    .terms-section {
      margin-top: 30px;
      padding: 15px;
      background: #f8f9fa;
      border-left: 4px solid #2c3e50;
    }
    
    .terms-title {
      font-weight: bold;
      margin-bottom: 10px;
      color: #2c3e50;
    }
    
    .terms-content {
      font-size: 10px;
      line-height: 1.4;
      color: #555;
    }
    
    @media print {
      body {
        font-size: 11px;
      }
      .container {
        padding: 10px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div class="logo-section">
        ${invoiceLogo ? `<img src="${invoiceLogo}" alt="Company Logo" class="logo">` : ''}
      </div>
      <div class="invoice-info">
        <div class="invoice-title">${correctionInvoiceReference ? `${t.correction} ` : ''}${defaultInvoiceTitle}</div>
        <div class="invoice-details">
          ${usedInvoiceNumber ? `<div><strong>${t.invoiceNumber}:</strong> ${usedInvoiceNumber}</div>` : ''}
          <div><strong>${t.date}:</strong> ${formatDate(invoiceDate)}</div>
        </div>
      </div>
    </div>

    <!-- Parties Information -->
    <div class="parties">
      <!-- To (Buyer) - Left side -->
      <div class="party party-to">
        <div class="party-title">${t.to}</div>
        <div class="party-info">
          ${buyer.companyName ? `<div class="company-name">${buyer.companyName}</div>` : ''}
          ${buyer.name ? `<div class="person-name">${buyer.name}</div>` : ''}
          <div>${buyer.street} ${buyer.streetNumber}</div>
          <div>${buyer.zipCode} ${buyer.city}</div>
          <div>${buyer.country}</div>
          ${buyer.email ? `<div>${t.email}: ${buyer.email}</div>` : ''}
          ${buyer.phone ? `<div>${t.phone}: ${buyer.phone}</div>` : ''}
          ${buyer.vatNumber ? `<div>${t.vat}: ${buyer.vatNumber}</div>` : ''}
        </div>
      </div>
      
      <!-- From (Seller) - Right side -->
      <div class="party party-from">
        <div class="party-title">${t.from}</div>
        <div class="party-info">
          ${seller.companyName ? `<div class="company-name">${seller.companyName}</div>` : ''}
          ${seller.name ? `<div class="person-name">${seller.name}</div>` : ''}
          <div>${seller.street} ${seller.streetNumber}</div>
          <div>${seller.zipCode} ${seller.city}</div>
          <div>${seller.country}</div>
          ${seller.email ? `<div>${t.email}: ${seller.email}</div>` : ''}
          ${seller.phone ? `<div>${t.phone}: ${seller.phone}</div>` : ''}
          ${seller.vatNumber ? `<div>${t.vat}: ${seller.vatNumber}</div>` : ''}
        </div>
      </div>
    </div>

    <!-- Correction Invoice Notice -->
    ${
      correctionInvoiceReference
        ? `
    <div class="correction-notice">
      <div class="correction-title">${correctionInvoiceReference.correctionTitle ?? t.correctionInvoice}</div>
      <div class="correction-details">
        ${correctionInvoiceReference.correctionDescription ?? t.correctionDefault(correctionInvoiceReference.originalInvoiceNumber, correctionInvoiceReference.originalInvoiceDate)}
        ${correctionInvoiceReference.correctionReason ? `<br><strong>${t.reason}:</strong> ${correctionInvoiceReference.correctionReason}` : ''}
      </div>
    </div>
    `
        : ''
    }

    <!-- Greeting -->
    ${invoiceGreetings ? `<div class="greeting">${invoiceGreetings}</div>` : ''}

    <!-- Items Table -->
    ${
      invoiceItems.length > 0
        ? `
    <table class="items-table">
      <thead>
        <tr>
          <th>${t.description}</th>
          <th class="text-center">${t.quantity}</th>
          <th class="text-right">${t.unitPrice}</th>
          <th class="text-right">${t.totalNet}</th>
        </tr>
      </thead>
      <tbody>
        ${Array.from(vatGroups.values())
          .map((group) => {
            const vatRateDisplay = (group.vatRate * 100).toFixed(1);

            return `
        <!-- VAT Category Header -->
        <tr class="vat-category-header">
          <td colspan="4"><strong>${t.vatRate}: ${vatRateDisplay}%</strong></td>
        </tr>
        ${group.items
          .map((item) => {
            const itemTotal = item.quantity * item.price;
            const itemVatRate = item.vatRateOverride ?? vatRate;
            const itemVatIsIncluded =
              item.vatIsIncludedInThePriceOverride ?? vatIsIncludedInThePrice;
            const itemDecimals = item.decimalsOverride ?? decimals;
            const itemCurrency =
              item.currencyOverride || item.currency || defaultCurrency;
            let netUnitPrice, netAmount;

            if (itemVatIsIncluded) {
              // Convert gross price to net price
              netUnitPrice = item.price / (1 + itemVatRate);
              netAmount = itemTotal / (1 + itemVatRate);
            } else {
              // Price is already net
              netUnitPrice = item.price;
              netAmount = itemTotal;
            }

            return `
        <tr>
          <td>${item.name}</td>
          <td class="text-center">${item.quantity}</td>
          <td class="text-right">${formatAmount(netUnitPrice, itemDecimals, itemCurrency)}</td>
          <td class="text-right">${formatAmount(netAmount, itemDecimals, itemCurrency)}</td>
        </tr>
        `;
          })
          .join('')}
        <!-- VAT Row -->
        ${
          group.vatRate > 0
            ? `
        <tr class="vat-row">
          <td colspan="3"><strong>${t.vat} (${vatRateDisplay}%)</strong></td>
          <td class="text-right"><strong>${formatAmount(group.vatAmount)}</strong></td>
        </tr>
        `
            : ''
        }
        <!-- Category Subtotal -->
        <tr class="vat-category-subtotal">
          <td colspan="3"><strong>${t.subtotal} (${vatRateDisplay}%)</strong></td>
          <td class="text-right"><strong>${formatAmount(group.grossTotal)}</strong></td>
        </tr>
        `;
          })
          .join('')}
      </tbody>
    </table>

    <!-- Total Section -->
    <div class="total-section">
      <div class="total-row">
        <span>${t.netTotal}:</span>
        <span>${formatAmount(totalNet)}</span>
      </div>
      ${Array.from(vatGroups.values())
        .filter((group) => group.vatAmount > 0)
        .map(
          (group) => `
      <div class="total-row">
        <span>${t.vat} (${(group.vatRate * 100).toFixed(1)}%):</span>
        <span>${formatAmount(group.vatAmount)}</span>
      </div>
      `,
        )
        .join('')}
      ${
        totalVat > 0
          ? `
      <div class="total-row">
        <span>${t.totalVat}:</span>
        <span>${formatAmount(totalVat)}</span>
      </div>
      `
          : ''
      }
      <div class="total-row final">
        <span>${t.totalAmount}:</span>
        <span>${formatAmount(totalGross)}</span>
      </div>
    </div>
    `
        : ''
    }

    <!-- Closing -->
    ${invoiceClosing ? `<div class="closing">${invoiceClosing}</div>` : ''}

    <!-- Signature -->
    ${invoiceSignature ? `<div class="signature">${invoiceSignature}</div>` : ''}

    <!-- Terms and Conditions -->
    ${
      (invoiceTerms && invoiceTerms.trim()) ||
      (invoicePrivacy && invoicePrivacy.trim())
        ? `
    <div class="terms-section">
      <div class="terms-title">${t.termsAndConditions}</div>
      <div class="terms-content">
        ${invoiceTerms && invoiceTerms.trim() ? invoiceTerms : ''}
        ${invoiceTerms && invoiceTerms.trim() && invoicePrivacy && invoicePrivacy.trim() ? `<br><br><strong>${t.privacyPolicy}:</strong><br>` : ''}
        ${invoicePrivacy && invoicePrivacy.trim() ? invoicePrivacy : ''}
      </div>
    </div>
    `
        : ''
    }

    <!-- Footer -->
    ${invoiceFooter ? `<div class="footer">${invoiceFooter}</div>` : ''}
  </div>
</body>
</html>
  `.trim();
}
