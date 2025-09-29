import { z } from 'zod';
import { postGenerateInvoiceSchemaInput } from '@/routes/api/invoice/index';
import { generateHash } from '../crypto';
import { $Enums } from '@prisma/client';

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

// Currency type definition
type Currency = {
  id: string; // Short ID like 'EUR', 'USD', 'ADA'
  symbol: string;
  decimals: number;
  symbolPosition: 'before' | 'after';
};

// Currency configuration with defaults
const CURRENCY_CONFIG: Record<string, Omit<Currency, 'id'>> = {
  USD: {
    symbol: '$',
    decimals: 2,
    symbolPosition: 'before',
  },
  GBP: {
    symbol: '£',
    decimals: 2,
    symbolPosition: 'before',
  },
  EUR: {
    symbol: '€',
    decimals: 2,
    symbolPosition: 'after',
  },
  ADA: {
    symbol: '₳',
    decimals: 6,
    symbolPosition: 'before',
  },
};

function getCurrencyConfig(currencyId: string): Currency {
  const config = CURRENCY_CONFIG[currencyId];
  if (config) {
    return {
      id: currencyId,
      ...config,
    };
  }
  // Default fallback for unknown currencies
  return {
    id: currencyId,
    symbol: currencyId,
    decimals: 2,
    symbolPosition: 'after',
  };
}

type InvoiceItem = {
  name: string;
  quantity: number;
  // Base price per unit (assumed net, without VAT)
  price: number;
  // VAT metadata
  vatRate: number;
  // Calculated amounts for the total line (quantity * price)
  priceWithoutVat: number;
  priceWithVat: number;
  vatAmount: number;
  // Optional conversion display (does not affect totals)
  conversionFactor?: number;
  conversionPrefix?: string;
  conversionSuffix?: string;
};

export type InvoiceGroupItemInput = {
  name: string;
  quantity: number;
  // Base price per unit (net, without VAT)
  price: number;
  vatRateOverride?: number | null;
  // Optional conversion display for itemization
  conversionFactor?: number | null;
  conversionPrefix?: string | null;
  conversionSuffix?: string | null;
};

export interface InvoiceGroup {
  vatRate: number;
  items: InvoiceItem[];
  netTotal: number;
  vatAmount: number;
  grossTotal: number;
}

// Language and region-specific configuration
const LOCALE_CONFIG = {
  'en-us': {
    texts: {
      itemNamePrefix: 'Agent: ',
      itemNameSuffix: '',
      invoice: 'Invoice',
      correction: 'Correction',
      correctionInvoice: 'CORRECTION INVOICE',
      correctionDefault: (invoiceNumber: string, invoiceDate: string) =>
        `This invoice corrects the original invoice #${invoiceNumber} dated ${invoiceDate}.`,
      defaultGreeting: 'Thank you for your business.',
      defaultClosing: 'Best regards,',
      defaultSignature: 'Accounts Receivable',
      defaultFooter:
        'This invoice was generated electronically and is valid without a signature.',
      defaultTerms: 'Payment due within 14 days of invoice date.',
      defaultPrivacy:
        'We process your personal data in accordance with our privacy policy.',
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
      itemNamePrefix: 'Agent: ',
      itemNameSuffix: '',
      invoice: 'Invoice',
      correction: 'Correction',
      correctionInvoice: 'CORRECTION INVOICE',
      correctionDefault: (invoiceNumber: string, invoiceDate: string) =>
        `This invoice corrects the original invoice #${invoiceNumber} dated ${invoiceDate}.`,
      defaultGreeting: 'Thank you for your business.',
      defaultClosing: 'Best regards,',
      defaultSignature: 'Accounts Receivable',
      defaultFooter:
        'This invoice was generated electronically and is valid without a signature.',
      defaultTerms: 'Payment due within 14 days of invoice date.',
      defaultPrivacy:
        'We process your personal data in accordance with our privacy policy.',
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
      itemNamePrefix: 'Agent: ',
      itemNameSuffix: '',
      invoice: 'Rechnung',
      correction: 'Korrektur',
      correctionInvoice: 'KORREKTURRECHNUNG',
      correctionDefault: (invoiceNumber: string, invoiceDate: string) =>
        `Diese Rechnung korrigiert die ursprüngliche Rechnung #${invoiceNumber} vom ${invoiceDate}.`,
      defaultGreeting: 'Vielen Dank für Ihr Vertrauen.',
      defaultClosing: 'Mit freundlichen Grüßen,',
      defaultSignature: 'Buchhaltung',
      defaultFooter:
        'Diese Rechnung wurde elektronisch erstellt und ist auch ohne Unterschrift gültig.',
      defaultTerms: 'Zahlbar innerhalb von 14 Tagen nach Rechnungsdatum.',
      defaultPrivacy:
        'Wir verarbeiten Ihre personenbezogenen Daten gemäß unserer Datenschutzerklärung.',
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

export type LanguageKey = keyof typeof LOCALE_CONFIG;

export type InvoiceTexts = {
  invoice: string;
  correction: string;
  correctionInvoice: string;
  correctionDefault: (invoiceNumber: string, invoiceDate: string) => string;
  defaultGreeting: string;
  defaultClosing: string;
  defaultSignature: string;
  defaultFooter: string;
  defaultTerms: string;
  defaultPrivacy: string;
  reason: string;
  from: string;
  to: string;
  description: string;
  quantity: string;
  unitPrice: string;
  totalNet: string;
  vatRate: string;
  netTotal: string;
  totalVat: string;
  totalAmount: string;
  subtotal: string;
  vat: string;
  date: string;
  invoiceNumber: string;
  email: string;
  phone: string;
  termsAndConditions: string;
  privacyPolicy: string;
};

function isLanguageKey(value: unknown): value is keyof typeof LOCALE_CONFIG {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(LOCALE_CONFIG, value)
  );
}

function resolveLanguageKey(value?: string): keyof typeof LOCALE_CONFIG {
  return isLanguageKey(value) ? value : 'en-us';
}

// Extracts the localized texts based on the invoice's language field
export function extractInvoiceTexts(language: LanguageKey): InvoiceTexts {
  const languageKey = resolveLanguageKey(language);
  const locale = LOCALE_CONFIG[languageKey];
  const t = locale.texts;
  return {
    invoice: t.invoice,
    correction: t.correction,
    correctionInvoice: t.correctionInvoice,
    correctionDefault: t.correctionDefault,
    defaultGreeting: t.defaultGreeting,
    defaultClosing: t.defaultClosing,
    defaultSignature: t.defaultSignature,
    defaultFooter: t.defaultFooter,
    defaultTerms: t.defaultTerms,
    defaultPrivacy: t.defaultPrivacy,
    reason: t.reason,
    from: t.from,
    to: t.to,
    description: t.description,
    quantity: t.quantity,
    unitPrice: t.unitPrice,
    totalNet: t.totalNet,
    vatRate: t.vatRate,
    netTotal: t.netTotal,
    totalVat: t.totalVat,
    totalAmount: t.totalAmount,
    subtotal: t.subtotal,
    vat: t.vat,
    date: t.date,
    invoiceNumber: t.invoiceNumber,
    email: t.email,
    phone: t.phone,
    termsAndConditions: t.termsAndConditions,
    privacyPolicy: t.privacyPolicy,
  };
}

export type ResolvedInvoiceConfig = {
  // Display fields (fully resolved)
  title: string;
  date: string;
  greeting: string;
  closing: string;
  signature: string;
  logo: string | null;
  footer: string;
  terms: string;
  privacy: string;
  id: string;
  correctionInvoiceReference: {
    correctionTitle: string;
    correctionDescription: string;
  } | null;
  itemNamePrefix: string;
  itemNameSuffix: string;
  currencyShortId: string;
  currencySymbol: string;
  currencySymbolPosition: $Enums.SymbolPosition;
  currencyDecimals: number;

  // Resolved formatting
  decimals: number;
  thousandDelimiter: ',' | '.' | ' ' | "'";
  decimalDelimiter: '.' | ',';
  language: LanguageKey;
  dateFormat: string;
  // Localized texts bundle
  texts: InvoiceTexts;
};

export function resolveInvoiceConfig(
  currencySettings: InvoiceData['currencySettings'],
  invoice?: InvoiceData['invoice'],
  correctionInvoiceData?: {
    correctionReason: string;
    correctionTitle: string;
    originalInvoiceNumber: string;
    originalInvoiceDate: string;
  },
): ResolvedInvoiceConfig {
  const languageKey = resolveLanguageKey(invoice?.language);
  const locale = LOCALE_CONFIG[languageKey];
  // Map each language to a sensible default currency
  const LANGUAGE_DEFAULT_CURRENCY: Record<LanguageKey, string> = {
    'en-us': 'USD',
    'en-uk': 'GBP',
    de: 'EUR',
  };
  const defaultCurrencyId = LANGUAGE_DEFAULT_CURRENCY[languageKey];
  const defaultCurrency = getCurrencyConfig(defaultCurrencyId);
  const resolvedId = invoice?.id ?? generateInvoiceId();
  const resolvedDate = invoice?.date ?? new Date().toLocaleDateString();

  const resolvedCurrencyShortId =
    currencySettings?.currencyId ?? defaultCurrency.id;
  const resolvedCurrencySymbol =
    currencySettings?.currencySymbol ?? defaultCurrency.symbol;
  const resolvedCurrencyDecimals =
    currencySettings?.currencyDecimals ?? defaultCurrency.decimals;
  const resolvedCurrencySymbolPosition =
    currencySettings?.currencySymbolPosition ??
    (defaultCurrency.symbolPosition === 'before'
      ? $Enums.SymbolPosition.Before
      : $Enums.SymbolPosition.After);
  return {
    itemNamePrefix: invoice?.itemNamePrefix ?? locale.texts.itemNamePrefix,
    itemNameSuffix: invoice?.itemNameSuffix ?? locale.texts.itemNameSuffix,
    currencyShortId: resolvedCurrencyShortId,
    currencySymbol: resolvedCurrencySymbol,
    currencySymbolPosition: resolvedCurrencySymbolPosition,
    currencyDecimals: resolvedCurrencyDecimals,
    title: invoice?.title?.trim() || locale.texts.invoice,
    date: resolvedDate,
    greeting: invoice?.greeting ?? locale.texts.defaultGreeting,
    closing: invoice?.closing ?? locale.texts.defaultClosing,
    signature: invoice?.signature ?? locale.texts.defaultSignature,
    logo: invoice?.logo ?? null,
    footer: invoice?.footer ?? locale.texts.defaultFooter,
    terms: invoice?.terms ?? locale.texts.defaultTerms,
    privacy: invoice?.privacy ?? locale.texts.defaultPrivacy,
    id: resolvedId,
    correctionInvoiceReference: correctionInvoiceData
      ? {
          correctionTitle:
            correctionInvoiceData?.correctionTitle?.trim() ||
            locale.texts.correctionInvoice,
          correctionDescription: locale.texts.correctionDefault(
            correctionInvoiceData?.originalInvoiceNumber?.trim() || resolvedId,
            correctionInvoiceData?.originalInvoiceDate?.trim() || resolvedDate,
          ),
        }
      : null,

    decimals: invoice?.decimals ?? 2,
    thousandDelimiter:
      invoice?.thousandDelimiter ?? locale.defaultThousandDelimiter,
    decimalDelimiter:
      invoice?.decimalDelimiter ?? locale.defaultDecimalDelimiter,
    language: languageKey,
    dateFormat: invoice?.dateFormat ?? locale.defaultDateFormat,
    texts: extractInvoiceTexts(languageKey),
  };
}

export function generateInvoiceGroups(
  items: readonly InvoiceGroupItemInput[] | null | undefined,
  vatRate: number,
): InvoiceGroup[] {
  const invoiceGroups = new Map<string, InvoiceGroup>();
  if (!items) return [];

  items.forEach((item) => {
    const itemVatRate = item.vatRateOverride ?? vatRate;
    const groupKey = `${itemVatRate}`; // Group by VAT rate only

    if (!invoiceGroups.has(groupKey)) {
      invoiceGroups.set(groupKey, {
        vatRate: itemVatRate,
        items: [],
        netTotal: 0,
        vatAmount: 0,
        grossTotal: 0,
      });
    }

    const group = invoiceGroups.get(groupKey)!;

    // Calculate item-level VAT and prices (assume base prices are net)
    const itemTotal = item.quantity * item.price;
    const netAmount = itemTotal;
    const vatAmount = itemTotal * itemVatRate;
    const grossAmount = itemTotal + vatAmount;

    // Create enhanced item with calculated values
    const enhancedItem: InvoiceItem = {
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      priceWithoutVat: netAmount,
      priceWithVat: grossAmount,
      vatRate: itemVatRate,
      vatAmount: vatAmount,
      conversionFactor: item.conversionFactor ?? undefined,
      conversionPrefix: item.conversionPrefix ?? undefined,
      conversionSuffix: item.conversionSuffix ?? undefined,
    };

    group.items.push(enhancedItem);

    // Update group totals
    group.netTotal += netAmount;
    group.vatAmount += vatAmount;
    group.grossTotal += grossAmount;
  });

  return Array.from(invoiceGroups.values());
}

export function generateInvoiceHTML(
  config: ResolvedInvoiceConfig,
  seller: InvoiceData['seller'],
  buyer: InvoiceData['buyer'],
  invoiceGroups: InvoiceGroup[],
): string {
  const {
    title,
    date,
    greeting,
    closing,
    signature,
    logo,
    footer,
    terms,
    privacy,
    id,
    correctionInvoiceReference,
    decimals,
    thousandDelimiter,
    decimalDelimiter,
    dateFormat,
    texts,
  } = config;

  const t = texts;
  const invoiceCurrency: Currency = {
    id: config.currencyShortId,
    symbol: config.currencySymbol,
    decimals: config.currencyDecimals,
    symbolPosition:
      config.currencySymbolPosition === $Enums.SymbolPosition.Before
        ? 'before'
        : 'after',
  };
  const defaultInvoiceTitle = title || t.invoice;

  // Determine delimiters (already resolved)
  const useThousandDelimiter = thousandDelimiter;
  const useDecimalDelimiter = decimalDelimiter;
  const useDateFormat = dateFormat;

  const usedInvoiceNumber = id ?? generateInvoiceId();

  // Group items by VAT rate and inclusion setting

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

  // Helper function to format amounts with currency-specific configuration
  const formatAmount = (
    amount: number,
    currency: Currency,
    itemDecimals?: number,
  ) => {
    const useDecimals = itemDecimals ?? currency.decimals ?? decimals;

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

    // Format with currency symbol
    if (currency.symbolPosition === 'before') {
      return `${currency.symbol}${formattedNum}`;
    } else {
      return `${formattedNum} ${currency.symbol}`;
    }
  };

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
        ${logo ? `<img src="${logo}" alt="Company Logo" class="logo">` : ''}
      </div>
      <div class="invoice-info">
        <div class="invoice-title">${correctionInvoiceReference ? `${t.correction} ` : ''}${defaultInvoiceTitle}</div>
        <div class="invoice-details">
          ${usedInvoiceNumber ? `<div><strong>${t.invoiceNumber}:</strong> ${usedInvoiceNumber}</div>` : ''}
          <div><strong>${t.date}:</strong> ${formatDate(date)}</div>
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
      <div class="correction-title">${correctionInvoiceReference.correctionTitle}</div>
      <div class="correction-details">
        ${correctionInvoiceReference.correctionDescription}
      </div>
    </div>
    `
        : ''
    }

    <!-- Greeting -->
    ${greeting ? `<div class="greeting">${greeting}</div>` : ''}

    <!-- Items Table -->
    ${
      invoiceGroups.length > 0
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
        ${Array.from(invoiceGroups.values())
          .map((group) => {
            const vatRateDisplay = (group.vatRate * 100).toFixed(1);

            return `
        <!-- VAT Category Header -->
        <tr class="vat-category-header">
          <td colspan="4"><strong>${t.vatRate}: ${vatRateDisplay}%</strong></td>
        </tr>
        ${group.items
          .map((item) => {
            const netUnitPrice = item.price; // Show the base price per unit
            const netAmount = item.priceWithoutVat || 0;

            return `
        <tr>
          <td>${item.name}</td>
          <td class="text-center">${item.quantity}</td>
          <td class="text-right">
            ${formatAmount(netUnitPrice, invoiceCurrency)}
            ${item.conversionFactor ? `<br><small>(${item.conversionPrefix ?? ''}${(netUnitPrice * item.conversionFactor).toFixed(2)}${item.conversionSuffix ?? ''})</small>` : ''}
          </td>
          <td class="text-right">
            ${formatAmount(netAmount, invoiceCurrency)}
            ${item.conversionFactor ? `<br><small>(${item.conversionPrefix ?? ''}${(netAmount * item.conversionFactor).toFixed(2)}${item.conversionSuffix ?? ''})</small>` : ''}
          </td>
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
          <td class="text-right"><strong>${formatAmount(group.vatAmount, invoiceCurrency)}</strong></td>
        </tr>
        `
            : ''
        }
        <!-- Category Subtotal -->
        <tr class="vat-category-subtotal">
          <td colspan="3"><strong>${t.subtotal} (${vatRateDisplay}%)</strong></td>
          <td class="text-right"><strong>${formatAmount(group.grossTotal, invoiceCurrency)}</strong></td>
        </tr>
        `;
          })
          .join('')}
      </tbody>
    </table>

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
      <div class="total-row">
        <span>${t.netTotal} (${invoiceCurrency.id}):</span>
        <span>${formatAmount(totals.net, invoiceCurrency)}</span>
      </div>
      ${
        totals.vat > 0
          ? `
      <div class="total-row">
        <span>${t.totalVat} (${invoiceCurrency.id}):</span>
        <span>${formatAmount(totals.vat, invoiceCurrency)}</span>
      </div>
      `
          : ''
      }
      <div class="total-row final">
        <span>${t.totalAmount} (${invoiceCurrency.id}):</span>
        <span>${formatAmount(totals.gross, invoiceCurrency)}</span>
      </div>`;
      })()}
    </div>
    `
        : ''
    }

    <!-- Closing -->
    ${closing ? `<div class="closing">${closing}</div>` : ''}

    <!-- Signature -->
    ${signature ? `<div class="signature">${signature}</div>` : ''}

    <!-- Terms and Conditions -->
    ${
      (terms && terms.trim()) || (privacy && privacy.trim())
        ? `
    <div class="terms-section">
      <div class="terms-title">${t.termsAndConditions}</div>
      <div class="terms-content">
        ${terms && terms.trim() ? terms : ''}
        ${terms && terms.trim() && privacy && privacy.trim() ? `<br><br><strong>${t.privacyPolicy}:</strong><br>` : ''}
        ${privacy && privacy.trim() ? privacy : ''}
      </div>
    </div>
    `
        : ''
    }

    <!-- Footer -->
    ${footer ? `<div class="footer">${footer}</div>` : ''}
  </div>
</body>
</html>
  `.trim();
}
