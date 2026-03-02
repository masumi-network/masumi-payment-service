import { z } from '@/utils/zod-openapi';
import { generateSHA256Hash } from '../crypto';

const invoiceDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD format')
	.refine((value) => {
		const parsed = new Date(`${value}T00:00:00.000Z`);
		return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
	}, 'Date is invalid');

export const invoiceSellerSchema = z.object({
	country: z.string().min(1).max(100).describe('The country of the invoice'),
	city: z.string().min(1).max(100).describe('The city of the invoice'),
	zipCode: z.string().min(1).max(20).describe('The zip code of the invoice'),
	street: z.string().min(1).max(100).describe('The street of the invoice'),
	streetNumber: z.string().min(1).max(20).describe('The street number of the invoice'),
	email: z.string().email().min(1).max(100).nullable().describe('The email of the invoice'),
	phone: z.string().min(1).max(100).nullable().describe('The phone of the invoice'),
	name: z.string().min(1).max(100).nullable().describe('The name of the invoice'),
	companyName: z.string().min(1).max(100).nullable().describe('The company name of the invoice'),
	vatNumber: z.string().min(1).max(100).nullable().describe('The VAT number of the invoice'),
});

export const invoiceBuyerSchema = z.object({
	country: z.string().min(1).max(100).describe('The country of the invoice'),
	city: z.string().min(1).max(100).describe('The city of the invoice'),
	zipCode: z.string().min(1).max(20).describe('The zip code of the invoice'),
	street: z.string().min(1).max(100).describe('The street of the invoice'),
	streetNumber: z.string().min(1).max(20).describe('The street number of the invoice'),
	email: z.string().email().min(1).max(100).nullable().describe('The email of the invoice'),
	phone: z.string().min(1).max(100).nullable().describe('The phone of the invoice'),
	name: z.string().min(1).max(100).nullable().describe('The name of the invoice'),
	companyName: z.string().min(1).max(100).nullable().describe('The company name of the invoice'),
	vatNumber: z.string().min(1).max(100).nullable().describe('The VAT number of the invoice'),
});

export const invoiceOptionsSchema = z
	.object({
		itemNamePrefix: z.string().min(1).max(100).optional().describe('The prefix of the item name'),
		itemNameSuffix: z.string().min(1).max(100).optional().describe('The suffix of the item name'),
		title: z.string().min(1).max(100).optional().describe('The title of the invoice'),
		description: z.string().min(1).max(1000).optional().describe('The description of the invoice'),
		idPrefix: z.string().min(1).max(100).optional().describe('The prefix of the invoice number'),
		date: invoiceDateSchema.optional().describe('The date of the invoice (YYYY-MM-DD)'),
		greeting: z.string().min(1).max(1000).optional().describe('The greetings of the invoice'),
		closing: z.string().min(1).max(1000).optional().describe('The closing of the invoice'),
		signature: z.string().min(1).max(1000).optional().describe('The signature of the invoice'),
		logo: z.string().min(1).max(1000).optional().describe('The logo of the invoice'),
		footer: z.string().min(1).max(1000).optional().describe('The footer of the invoice'),
		terms: z.string().min(1).max(1000).optional().describe('The terms of the invoice'),
		privacy: z.string().min(1).max(1000).optional().describe('The privacy of the invoice'),
		language: z
			.enum(['en-us', 'en-gb', 'de'])
			.optional()
			.describe('Invoice language and region: English US (en-us), English GB (en-gb), or German (de). Default: en-us'),
		localizationFormat: z.enum(['en-us', 'en-gb', 'de']).optional().describe('The localization format of the invoice'),
	})
	.optional();

export type InvoiceSeller = z.infer<typeof invoiceSellerSchema>;
export type InvoiceBuyer = z.infer<typeof invoiceBuyerSchema>;
export type InvoiceOptions = z.infer<typeof invoiceOptionsSchema>;
export function generateNewInvoiceBaseId(baseIdPrefix?: string): string {
	const randomData = crypto.randomUUID();
	const randomHash = generateSHA256Hash(randomData);
	//replace all non-numbers with their ASCII code
	const numberHash = randomHash.replace(/[^0-9]/g, (char) => (char.charCodeAt(0) % 10).toString());
	const randomHashShort = `${numberHash.slice(0, 2)}-${numberHash.slice(2, 6)}`;
	return `${baseIdPrefix ? `${baseIdPrefix}-` : ''}${randomHashShort}`;
}

export function generateInvoiceId(revisionNumber: number, baseId: string): string {
	return `${baseId}-${revisionNumber}`;
}

// Runtime-safe list of supported currencies for validation and typing
export const supportedCurrencies = ['usd', 'eur', 'gbp', 'jpy', 'chf', 'aed'] as const;

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
			monthlyInvoice: 'Monthly Invoice',
			cancellationInvoice: 'CANCELLATION INVOICE',
			cancellationDefault: (invoiceNumber: string, invoiceDate: string) =>
				`This cancellation invoice reverses the original invoice #${invoiceNumber} dated ${invoiceDate}.`,
			reverseChargeNotice:
				'Reverse charge: VAT to be accounted for by the recipient pursuant to Article 196 of the EU VAT Directive.',
			defaultGreeting: 'Thank you for your business.',
			defaultClosing: 'Best regards,',
			defaultSignature: 'Accounts Receivable',
			defaultFooter: 'This invoice was generated electronically and is valid without a signature.',
			defaultTerms: '',
			defaultPrivacy: 'We process your personal data in accordance with our privacy policy.',
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
			cancellationReasonItemsChanged: 'Changes to items and/or their prices',
			cancellationReasonSellerChanged: 'Changes to seller data',
			cancellationReasonBuyerChanged: 'Changes to buyer data',
			cancellationReasonMetadataChanged: 'Changes to texts and formatting',
			servicePeriod: 'Service Period',
			conversionText: 'Conversion Factor: ',
			coingeckoAttribution: 'Conversions and price data by',
			conversionRates: 'Conversion Rates',
			conversionAsset: 'Asset',
			conversionRate: 'Rate',
		},
	},
	de: {
		texts: {
			itemNamePrefix: 'Agent: ',
			itemNameSuffix: '',
			invoice: 'Rechnung',
			monthlyInvoice: 'Monatsrechnung',
			cancellationInvoice: 'STORNORECHNUNG',
			cancellationDefault: (invoiceNumber: string, invoiceDate: string) =>
				`Diese Stornorechnung storniert die ursprüngliche Rechnung #${invoiceNumber} vom ${invoiceDate}.`,
			reverseChargeNotice: 'Steuerschuldnerschaft des Leistungsempfängers gem. §13b UStG.',
			defaultGreeting: 'Vielen Dank für Ihr Vertrauen.',
			defaultClosing: 'Mit freundlichen Grüßen,',
			defaultSignature: 'Buchhaltung',
			defaultFooter: 'Diese Rechnung wurde elektronisch erstellt und ist auch ohne Unterschrift gültig.',
			defaultTerms: '',
			defaultPrivacy: 'Wir verarbeiten Ihre personenbezogenen Daten gemäß unserer Datenschutzerklärung.',
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
			cancellationReasonItemsChanged: 'Änderungen an den Artikeln und/oder ihren Preisen',
			cancellationReasonSellerChanged: 'Änderungen an den Verkäuferdaten',
			cancellationReasonBuyerChanged: 'Änderungen an den Käuferdaten',
			cancellationReasonMetadataChanged: 'Änderungen an Texten und Formatierungen',
			servicePeriod: 'Leistungszeitraum',
			conversionText: 'Umrechnungsfaktor: ',
			coingeckoAttribution: 'Konvertierung und Preisdaten von',
			conversionRates: 'Umrechnungskurse',
			conversionAsset: 'Währung',
			conversionRate: 'Kurs',
		},
	},
} as const;

export type LanguageKey = keyof typeof LOCALE_CONFIG;

export type InvoiceTexts = {
	invoice: string;
	monthlyInvoice?: string;
	cancellationInvoice: string;
	cancellationDefault: (invoiceNumber: string, invoiceDate: string) => string;
	reverseChargeNotice: string;
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
	cancellationReasonItemsChanged: string;
	cancellationReasonSellerChanged: string;
	cancellationReasonBuyerChanged: string;
	cancellationReasonMetadataChanged: string;
	servicePeriod: string;
	conversionText: string;
	coingeckoAttribution: string;
	conversionRates: string;
	conversionAsset: string;
	conversionRate: string;
};

function isLanguageKey(value: unknown): value is keyof typeof LOCALE_CONFIG {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCALE_CONFIG, value);
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
		monthlyInvoice: t.monthlyInvoice,
		cancellationInvoice: t.cancellationInvoice,
		cancellationDefault: t.cancellationDefault,
		reverseChargeNotice: t.reverseChargeNotice,
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
		cancellationReasonItemsChanged: t.cancellationReasonItemsChanged,
		cancellationReasonSellerChanged: t.cancellationReasonSellerChanged,
		cancellationReasonBuyerChanged: t.cancellationReasonBuyerChanged,
		cancellationReasonMetadataChanged: t.cancellationReasonMetadataChanged,
		servicePeriod: t.servicePeriod,
		conversionText: t.conversionText,
		coingeckoAttribution: t.coingeckoAttribution,
		conversionRates: t.conversionRates,
		conversionAsset: t.conversionAsset,
		conversionRate: t.conversionRate,
	};
}

export type SupportedCurrencies = (typeof supportedCurrencies)[number];
export type ResolvedInvoiceConfig = {
	// Display fields (fully resolved)
	title: string;
	description: string;
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

/** Maps internal locale keys to BCP 47 tags for Intl formatters */
function toBcp47(locale: string): string {
	const mapping: Record<string, string> = {
		'en-us': 'en-US',
		'en-gb': 'en-GB',
		de: 'de-DE',
	};
	return mapping[locale] ?? locale;
}

export function resolveInvoiceConfig(
	currency: SupportedCurrencies,
	invoice?: InvoiceOptions,
	options?: { invoiceType?: 'monthly' },
): ResolvedInvoiceConfig {
	const languageKey = resolveLanguageKey(invoice?.language);
	const locale = LOCALE_CONFIG[languageKey];

	const resolvedDate = invoice?.date ? new Date(invoice?.date) : new Date();
	// Default localization format matches the language (de → de-DE, not en-US)
	const defaultLocale = languageKey === 'de' ? 'de' : 'en-gb';
	const resolvedLocalizationFormat = invoice?.localizationFormat ?? invoice?.language ?? defaultLocale;
	const bcp47Locale = toBcp47(resolvedLocalizationFormat);
	const currencyFormatter = new Intl.NumberFormat(bcp47Locale, {
		style: 'currency',
		currency: currency,
	});
	const numberFormatter = new Intl.NumberFormat(bcp47Locale, {
		style: 'decimal',
	});
	const dateFormatter = new Intl.DateTimeFormat(bcp47Locale, {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
	});

	const texts = extractInvoiceTexts(languageKey);
	const isMonthly = options?.invoiceType === 'monthly';
	const defaultTitle = isMonthly ? (texts.monthlyInvoice ?? locale.texts.invoice) : locale.texts.invoice;

	return {
		itemNamePrefix: invoice?.itemNamePrefix ?? locale.texts.itemNamePrefix,
		itemNameSuffix: invoice?.itemNameSuffix ?? locale.texts.itemNameSuffix,
		currency: currency,
		title: invoice?.title?.trim() || defaultTitle,
		description: invoice?.description?.trim() || '',
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
		localizationFormat: resolvedLocalizationFormat,
		texts: texts,
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
const MAINNET_USDM_UNIT = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
const PREPROD_USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';

export function formatCryptoUnitConversion(convertedUnit: string, conversionFactor: string) {
	let unitName = convertedUnit;
	if (convertedUnit === '') {
		unitName = 'ADA';
	} else if (convertedUnit === MAINNET_USDM_UNIT) {
		unitName = 'USDM';
	} else if (convertedUnit === PREPROD_USDM_UNIT) {
		unitName = 'tUSDM';
	}
	return ` ${conversionFactor} ${unitName}`;
}
