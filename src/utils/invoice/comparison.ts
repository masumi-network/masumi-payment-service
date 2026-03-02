import stringify from 'canonical-json';
import {
	generateInvoiceGroups,
	generateInvoiceId,
	InvoiceGroup,
	InvoiceSeller,
	InvoiceBuyer,
	ResolvedInvoiceConfig,
} from './template';

type PartyFields = {
	name: string | null;
	companyName: string | null;
	vatNumber: string | null;
	country: string;
	city: string;
	zipCode: string;
	street: string;
	streetNumber: string;
	email: string | null;
	phone: string | null;
};

export function partiesEqual(a: PartyFields, b: PartyFields): boolean {
	return (
		a.name === b.name &&
		a.companyName === b.companyName &&
		a.vatNumber === b.vatNumber &&
		a.country === b.country &&
		a.city === b.city &&
		a.zipCode === b.zipCode &&
		a.street === b.street &&
		a.streetNumber === b.streetNumber &&
		a.email === b.email &&
		a.phone === b.phone
	);
}

export function detectInvoiceChanges(
	existingRevision: {
		InvoiceItems: Array<{
			name: string;
			quantity: { toString(): string } | number;
			pricePerUnitWithoutVat: { toString(): string } | number;
			vatRate: { toString(): string } | number;
			decimals: { toString(): string } | number;
			conversionFactor: { toString(): string } | number;
			convertedUnit: string;
			conversionDate: Date;
		}>;
		InvoiceBase: {
			invoiceId: string;
		};
		revisionNumber: number;
		currencyShortId: string;
		sellerName?: string | null;
		sellerCompanyName?: string | null;
		sellerVatNumber?: string | null;
		sellerCountry?: string;
		sellerCity?: string;
		sellerZipCode?: string;
		sellerStreet?: string;
		sellerStreetNumber?: string;
		sellerEmail?: string | null;
		sellerPhone?: string | null;
		buyerName?: string | null;
		buyerCompanyName?: string | null;
		buyerVatNumber?: string | null;
		buyerCountry?: string;
		buyerCity?: string;
		buyerZipCode?: string;
		buyerStreet?: string;
		buyerStreetNumber?: string;
		buyerEmail?: string | null;
		buyerPhone?: string | null;
		invoiceTitle?: string | null;
		invoiceDescription?: string | null;
		invoiceDate: Date;
		invoiceGreetings?: string | null;
		invoiceClosing?: string | null;
		invoiceSignature?: string | null;
		invoiceLogo?: string | null;
		invoiceFooter?: string | null;
		invoiceTerms?: string | null;
		invoicePrivacy?: string | null;
		localizationFormat: string;
		language?: string | null;
	},
	newGroups: InvoiceGroup[],
	seller: InvoiceSeller,
	buyer: InvoiceBuyer,
	resolved: ResolvedInvoiceConfig,
): { hasChanges: boolean; reasons: string[] } {
	// Compare groups — strip conversion-dependent fields (price, conversionFactor,
	// decimals, convertedUnit, conversionDate) so that conversion rate fluctuations
	// between lookups don't trigger false changes. Only business-relevant fields
	// (name, quantity, vatRate) are compared.
	const existingItems = existingRevision.InvoiceItems.map((it) => ({
		name: it.name,
		quantity: Number(it.quantity.toString()),
		price: Number(it.pricePerUnitWithoutVat.toString()),
		vatRateOverride: Number(it.vatRate.toString()),
		decimals: Number(it.decimals.toString()),
		conversionFactor: Number(it.conversionFactor.toString()),
		convertedUnit: it.convertedUnit,
		conversionDate: it.conversionDate,
	}));
	const existingGroups = generateInvoiceGroups(existingItems, 0);

	const stripForComparison = (groups: InvoiceGroup[]) =>
		groups.map((group) => ({
			vatRate: group.vatRate,
			items: group.items.map((item) => ({
				name: item.name,
				quantity: item.quantity,
				price: Math.round(item.price * 1e4) / 1e4,
			})),
		}));

	const itemsChanged = stringify(stripForComparison(existingGroups)) !== stringify(stripForComparison(newGroups));

	// Compare parties
	const existingSeller: PartyFields = {
		name: existingRevision.sellerName ?? null,
		companyName: existingRevision.sellerCompanyName ?? null,
		vatNumber: existingRevision.sellerVatNumber ?? null,
		country: existingRevision.sellerCountry ?? '',
		city: existingRevision.sellerCity ?? '',
		zipCode: existingRevision.sellerZipCode ?? '',
		street: existingRevision.sellerStreet ?? '',
		streetNumber: existingRevision.sellerStreetNumber ?? '',
		email: existingRevision.sellerEmail ?? null,
		phone: existingRevision.sellerPhone ?? null,
	};
	const existingBuyer: PartyFields = {
		name: existingRevision.buyerName ?? null,
		companyName: existingRevision.buyerCompanyName ?? null,
		vatNumber: existingRevision.buyerVatNumber ?? null,
		country: existingRevision.buyerCountry ?? '',
		city: existingRevision.buyerCity ?? '',
		zipCode: existingRevision.buyerZipCode ?? '',
		street: existingRevision.buyerStreet ?? '',
		streetNumber: existingRevision.buyerStreetNumber ?? '',
		email: existingRevision.buyerEmail ?? null,
		phone: existingRevision.buyerPhone ?? null,
	};
	const sellerChanged = !partiesEqual(existingSeller, seller);
	const buyerChanged = !partiesEqual(existingBuyer, buyer);

	const existingDateIso = existingRevision.invoiceDate.toISOString().slice(0, 10);
	const resolvedDateIso = resolved.date.toISOString().slice(0, 10);

	const metadataChanged =
		resolved.currency !== existingRevision.currencyShortId ||
		(resolved.title ?? '') !== (existingRevision.invoiceTitle ?? '') ||
		(resolved.description ?? '') !== (existingRevision.invoiceDescription ?? '') ||
		resolvedDateIso !== existingDateIso ||
		(resolved.greeting ?? '') !== (existingRevision.invoiceGreetings ?? '') ||
		(resolved.closing ?? '') !== (existingRevision.invoiceClosing ?? '') ||
		(resolved.signature ?? '') !== (existingRevision.invoiceSignature ?? '') ||
		(resolved.logo ?? '') !== (existingRevision.invoiceLogo ?? '') ||
		(resolved.footer ?? '') !== (existingRevision.invoiceFooter ?? '') ||
		(resolved.terms ?? '') !== (existingRevision.invoiceTerms ?? '') ||
		(resolved.privacy ?? '') !== (existingRevision.invoicePrivacy ?? '') ||
		resolved.localizationFormat !== existingRevision.localizationFormat ||
		resolved.language !== (existingRevision.language ?? '');

	const reasons: string[] = [];
	if (itemsChanged) reasons.push('Invoice items were updated (name, quantity, or VAT rate changed)');
	if (sellerChanged) reasons.push('Seller data was updated');
	if (buyerChanged) reasons.push('Buyer data was updated');
	if (metadataChanged) reasons.push('Invoice text or formatting changed');

	return { hasChanges: reasons.length > 0, reasons };
}

export function getOriginalInvoiceInfo(existingRevision: {
	InvoiceBase: { invoiceId: string };
	revisionNumber: number;
	invoiceDate: Date;
	localizationFormat: string;
}): { originalInvoiceNumber: string; originalInvoiceDate: string } {
	const dateFormatter = new Intl.DateTimeFormat(existingRevision.localizationFormat, {
		dateStyle: 'short',
	});
	return {
		originalInvoiceNumber: generateInvoiceId(existingRevision.revisionNumber, existingRevision.InvoiceBase.invoiceId),
		originalInvoiceDate: dateFormatter.format(existingRevision.invoiceDate),
	};
}
