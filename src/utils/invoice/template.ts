import { z } from 'zod';
import { postGenerateInvoiceSchemaInput } from '@/routes/api/invoice/index';
import { generateHash } from '../crypto';

type InvoiceData = z.infer<typeof postGenerateInvoiceSchemaInput>;
export function generateNewInvoiceBaseId(baseIdPrefix?: string): string {
  const randomData = crypto.randomUUID();
  const randomHash = generateHash(randomData);
  //replace all non-numbers with their ASCII code
  const numberHash = randomHash.replace(/[^0-9]/g, (char) =>
    (char.charCodeAt(0) % 10).toString(),
  );
  const randomHashShort = `${numberHash.slice(0, 2)}-${numberHash.slice(2, 6)}`;
  return `${baseIdPrefix ? `${baseIdPrefix}-` : ''}${randomHashShort}`;
}

export function generateInvoiceId(
  revisionNumber: number,
  baseId: string,
): string {
  return `${baseId}-${revisionNumber}`;
}
// Currency type definition
type Currency = {
  id: string; // Short ID like 'EUR', 'USD', 'ADA'
  symbol: string;
  decimals: number;
  symbolPosition: 'before' | 'after';
};
// Runtime-safe list of supported currencies for validation and typing
export const supportedCurrencies = [
  'usd',
  'eur',
  'gbp',
  'jpy',
  'chf',
  'aed',
] as const;
// Currency configuration with defaults
const CURRENCY_CONFIG: Record<
  (typeof supportedCurrencies)[number],
  Omit<Currency, 'id'>
> = {
  usd: {
    symbol: '$',
    decimals: 2,
    symbolPosition: 'before',
  },
  gbp: {
    symbol: '£',
    decimals: 2,
    symbolPosition: 'before',
  },
  eur: {
    symbol: '€',
    decimals: 2,
    symbolPosition: 'after',
  },
  jpy: {
    symbol: '¥',
    decimals: 0,
    symbolPosition: 'before',
  },
  chf: {
    symbol: 'CHF',
    decimals: 2,
    symbolPosition: 'before',
  },
  aed: {
    symbol: 'AED',
    decimals: 2,
    symbolPosition: 'before',
  },
};

function getCurrencyConfig(
  currencyId: (typeof supportedCurrencies)[number],
): Currency {
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
  conversionFactor: number;
  decimals: number;
  convertedUnit: string;
  conversionDate: Date;
};

export type InvoiceGroupItemInput = {
  name: string;
  quantity: number;
  // Base price per unit (net, without VAT)
  price: number;
  vatRateOverride?: number | null;

  decimals: number;
  conversionFactor: number;
  convertedUnit: string;
  conversionDate: Date;
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
  en: {
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
      defaultTerms: '',
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
      correctionReasonItemsChanged: 'Changes to items and/or their prices',
      correctionReasonSellerChanged: 'Changes to seller data',
      correctionReasonBuyerChanged: 'Changes to buyer data',
      correctionReasonMetadataChanged: 'Changes to texts and formatting',
      conversionText: 'Conversion Factor: ',
      coingeckoAttribution: 'Conversions and price data by',
    },
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
      defaultTerms: '',
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
      correctionReasonItemsChanged:
        'Änderungen an den Artikeln und/oder ihren Preisen',
      correctionReasonSellerChanged: 'Änderungen an den Verkäuferdaten',
      correctionReasonBuyerChanged: 'Änderungen an den Käuferdaten',
      correctionReasonMetadataChanged:
        'Änderungen an Texten und Formatierungen',
      conversionText: 'Umrechnungsfaktor: ',
      coingeckoAttribution: 'Konvertierung und Preisdaten von',
    },
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
  correctionReasonItemsChanged: string;
  correctionReasonSellerChanged: string;
  correctionReasonBuyerChanged: string;
  correctionReasonMetadataChanged: string;
  conversionText: string;
  coingeckoAttribution: string;
};

function isLanguageKey(value: unknown): value is keyof typeof LOCALE_CONFIG {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(LOCALE_CONFIG, value)
  );
}

function resolveLanguageKey(value?: string): keyof typeof LOCALE_CONFIG {
  return isLanguageKey(value) ? value : 'en';
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
    correctionReasonItemsChanged: t.correctionReasonItemsChanged,
    correctionReasonSellerChanged: t.correctionReasonSellerChanged,
    correctionReasonBuyerChanged: t.correctionReasonBuyerChanged,
    correctionReasonMetadataChanged: t.correctionReasonMetadataChanged,
    conversionText: t.conversionText,
    coingeckoAttribution: t.coingeckoAttribution,
  };
}

export type SupportedCurrencies = (typeof supportedCurrencies)[number];
export type ResolvedInvoiceConfig = {
  // Display fields (fully resolved)
  title: string;
  date: Date;
  greeting: string;
  closing: string;
  signature: string;
  logo: string | null;
  footer: string;
  terms: string;
  privacy: string;
  itemNamePrefix: string;
  itemNameSuffix: string;
  currency: SupportedCurrencies;
  // Resolved formatting
  language: LanguageKey;
  currencyFormatter: Intl.NumberFormat;
  numberFormatter: Intl.NumberFormat;
  dateFormatter: Intl.DateTimeFormat;
  localizationFormat: string;
  texts: InvoiceTexts;
};

export function resolveInvoiceConfig(
  currency: InvoiceData['invoiceCurrency'],
  invoice?: InvoiceData['invoice'],
): ResolvedInvoiceConfig {
  const languageKey = resolveLanguageKey(invoice?.language);
  const locale = LOCALE_CONFIG[languageKey];

  const resolvedDate = invoice?.date ? new Date(invoice?.date) : new Date();
  const localizationFormat = invoice?.language ?? 'en-US';
  const currencyFormatter = new Intl.NumberFormat(
    invoice?.localizationFormat ?? localizationFormat,
    {
      style: 'currency',
      currency: currency,
    },
  );
  const numberFormatter = new Intl.NumberFormat(
    invoice?.localizationFormat ?? localizationFormat,
    {
      style: 'decimal',
    },
  );
  const dateFormatter = new Intl.DateTimeFormat(
    invoice?.localizationFormat ?? localizationFormat,
    {
      dateStyle: 'short',
    },
  );

  return {
    itemNamePrefix: invoice?.itemNamePrefix ?? locale.texts.itemNamePrefix,
    itemNameSuffix: invoice?.itemNameSuffix ?? locale.texts.itemNameSuffix,
    currency: currency,
    title: invoice?.title?.trim() || locale.texts.invoice,
    date: resolvedDate,
    greeting: invoice?.greeting ?? locale.texts.defaultGreeting,
    closing: invoice?.closing ?? locale.texts.defaultClosing,
    signature: invoice?.signature ?? locale.texts.defaultSignature,
    logo: invoice?.logo ?? null,
    footer: invoice?.footer ?? locale.texts.defaultFooter,
    terms: invoice?.terms ?? locale.texts.defaultTerms,
    privacy: invoice?.privacy ?? locale.texts.defaultPrivacy,
    language: languageKey,
    currencyFormatter: currencyFormatter,
    numberFormatter: numberFormatter,
    dateFormatter: dateFormatter,
    localizationFormat: invoice?.localizationFormat ?? 'en-US',
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
      decimals: item.decimals,
      conversionFactor: item.conversionFactor,
      convertedUnit: item.convertedUnit,
      conversionDate: item.conversionDate,
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
  newInvoiceId: string,
  correctionInvoiceReference: {
    correctionTitle: string;
    correctionDescription: string;
  } | null,
  includeCoingeckoAttribution: boolean = false,
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
    currencyFormatter,
    numberFormatter,
    dateFormatter,
    texts,
  } = config;

  const t = texts;
  const defaultInvoiceTitle = title || t.invoice;

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
      --surface-muted: #f4f6fb;
      --border: #d8deeb;
      --border-strong: #bcc5d6;
      --primary: #1f3b73;
      --primary-accent: #0f5ad9;
      --text: #1f2430;
      --text-muted: #5b6577;
      --accent: #e9efff;
      --warning-bg: #fff6e0;
      --warning-border: #f7ca63;
      --warning-text: #8a6212;
      --shadow: 0 12px 24px rgba(31, 59, 115, 0.08);
    }

    body {
      font-family: 'Arial', sans-serif;
      font-size: 12px;
      line-height: 1.6;
      color: var(--text);
      padding: 24px 12px;
    }

    .container {
      max-width: 830px;
      margin: 0 auto;
      padding: 24px 28px;
      background: var(--surface);
      border-radius: 8px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
    }

    .header {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      align-items: flex-start;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border-strong);
      margin-bottom: 22px;
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
      background: rgba(15, 90, 217, 0.16);
      color: var(--primary-accent);
    }

    .parties {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }

    .party-card {
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--surface);
      display: grid;
      gap: 5px;
      font-size: 11px;
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

    .greeting {
      margin-bottom: 18px;
      font-style: italic;
      color: var(--text-muted);
      font-size: 12px;
    }

    .correction-notice {
      background: var(--warning-bg);
      border: 1px solid var(--warning-border);
      border-radius: 6px;
      padding: 12px 14px;
      margin: 18px 0;
      color: var(--warning-text);
      display: grid;
      gap: 4px;
    }

    .correction-title {
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 1.2px;
      text-transform: uppercase;
    }

    .correction-details {
      font-size: 11px;
      line-height: 1.5;
    }

    .table-wrapper {
      overflow: hidden;
      border-radius: 6px;
      border: 1px solid var(--border-strong);

      margin-bottom: 20px;
      background: var(--surface);
    }

    .items-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .items-table thead tr {
      background: var(--primary);
      color: #fff;
    }

    .items-table th {
      padding: 10px 12px;
      text-align: left;
      font-weight: 600;
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    .items-table td {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      color: var(--text);
    }

    .items-table tbody tr:nth-child(even) {
      background: transparent;
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
      margin-bottom: 16px;
    }

    .totals-card {
      padding: 12px 14px;
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      background: rgba(15, 90, 217, 0.04);
      display: grid;
      gap: 6px;
    }

    .total-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--text);
      font-size: 11px;
    }

    .total-row.final {
      font-weight: 700;
      font-size: 13px;
      color: var(--primary);
      padding-top: 6px;
      border-top: 1px solid rgba(31, 59, 115, 0.2);
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

    .terms-section {
      display: none;
    }

    .footer {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--border-strong);
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
     margin-top: 25px;
     display: flex;
     justify-content: flex-end;
     align-items: flex-end;
    }

    @media print {
      body {
        background: #fff;
        padding: 0;
        font-size: 11px;
      }

      .container {
        box-shadow: none;
        border-radius: 0;
        border: none;
        padding: 18px 20px;
      }

      .table-wrapper {
        box-shadow: none;
      }

      .totals-card {
        background: rgba(15, 90, 217, 0.08);
      }

      .badge {
        background: rgba(15, 90, 217, 0.2) !important;
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
          ${correctionInvoiceReference ? `<span class="badge">${t.correction}</span>` : ''}
        </div>
      </div>
    </div>

    <!-- Parties Information -->
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
      <div class="party-card">
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
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${t.description}</div>
    <div class="table-wrapper">
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
              const vatRateDisplay = numberFormatter.format(
                group.vatRate * 100,
              );

              return `
          <tr class="vat-category-header">
            <td colspan="4">${t.vatRate}: ${vatRateDisplay}%</td>
          </tr>
          ${group.items
            .map((item) => {
              const netUnitPrice = item.price;
              const netAmount = item.priceWithoutVat || 0;
              return `
          <tr>
            <td>${item.name}
            <br><small>${t.conversionText} ${currencyFormatter.format(1)} = ${formatCryptoUnitConversion(item.convertedUnit, numberFormatter.format(item.conversionFactor / 10 ** item.decimals))}<br>(${dateFormatter.format(item.conversionDate)})</small>
            </td>
            <td class="text-center">${item.quantity}</td>
            <td class="text-right">${currencyFormatter.format(netUnitPrice)}</td>
            <td class="text-right">${currencyFormatter.format(netAmount)}</td>
          </tr>
          `;
            })
            .join('')}
          ${
            group.vatRate > 0
              ? `
          <tr class="vat-row">
            <td colspan="3"><strong>${t.vat} (${vatRateDisplay}%)</strong></td>
            <td class="text-right"><strong>${currencyFormatter.format(group.vatAmount)}</strong></td>
          </tr>
          `
              : ''
          }
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
          <span class="total-label">${t.netTotal}</span>
          <span class="total-value">${currencyFormatter.format(totals.net)}</span>
        </div>
        ${
          totals.vat > 0
            ? `
        <div class="total-row">
          <span class="total-label">${t.totalVat}</span>
          <span class="total-value">${currencyFormatter.format(totals.vat)}</span>
        </div>
        `
            : ''
        }
        <div class="total-row final">
          <span class="total-label">${t.totalAmount}</span>
          <span class="total-value">${currencyFormatter.format(totals.gross)}</span>
        </div>
      </div>`;
      })()}
    </div>
    `
        : ''
    }

    <!-- Footer -->
    ${footer ? `<div class="footer">${footer}</div>` : ''}
    ${includeCoingeckoAttribution ? `<div class="attribution"><span>${t.coingeckoAttribution} <a href="https://www.coingecko.com" target="_blank" rel="noopener noreferrer" class="coingecko-link">CoinGecko<svg class="coingecko-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5h6v6M11 5 5 11" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg></a></span></div>` : ''}
  </div>
</body>
</html>
  `.trim();
}
function formatCryptoUnitConversion(
  convertedUnit: string,
  conversionFactor: string,
) {
  let unitName = convertedUnit;
  if (convertedUnit == '') {
    unitName = 'ADA';
  } else if (
    convertedUnit ==
      '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d' ||
    convertedUnit ==
      'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d'
  ) {
    unitName = 'USDM';
  }
  return ` ${conversionFactor} ${unitName}`;
}
