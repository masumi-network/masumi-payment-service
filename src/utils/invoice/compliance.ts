import createHttpError from 'http-errors';

export interface InvoiceComplianceInput {
	reverseCharge: boolean;
	seller: { vatNumber: string | null };
	buyer: { vatNumber: string | null };
}

export function mergePaymentsById<T extends { id: string }>(...lists: readonly T[][]): T[] {
	const merged = new Map<string, T>();
	for (const list of lists) {
		for (const entry of list) {
			if (!merged.has(entry.id)) {
				merged.set(entry.id, entry);
			}
		}
	}
	return Array.from(merged.values());
}

function toBcp47Locale(localizationFormat: string): string {
	const mapping: Record<string, string> = {
		'en-us': 'en-US',
		'en-gb': 'en-GB',
		de: 'de-DE',
	};
	return mapping[localizationFormat] ?? localizationFormat;
}

export function getServicePeriodLabel(year: number, monthIdx: number, localizationFormat: string): string {
	const locale = toBcp47Locale(localizationFormat);
	return new Intl.DateTimeFormat(locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(year, monthIdx, 1)));
}

export function validateInvoiceCompliance(input: InvoiceComplianceInput, effectiveVatRate: number): void {
	const sellerVatNumber = input.seller.vatNumber?.trim();
	const buyerVatNumber = input.buyer.vatNumber?.trim();
	const requiresSellerVat = effectiveVatRate > 0 || input.reverseCharge;

	if (requiresSellerVat && !sellerVatNumber) {
		throw createHttpError(
			400,
			'Seller VAT number is required when VAT is applied or reverse charge is enabled (EU VAT compliance).',
		);
	}

	if (input.reverseCharge && !buyerVatNumber) {
		throw createHttpError(400, 'Buyer VAT number is required when reverse charge is enabled (EU VAT compliance).');
	}
}
