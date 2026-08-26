import { z } from '@masumi/payment-core/zod';
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

export { generateInvoiceHTML } from './html-template';
export { MAINNET_USDCX_UNIT, MAINNET_USDM_UNIT, PREPROD_USDM_UNIT, formatCryptoUnitConversion } from './crypto-units';
