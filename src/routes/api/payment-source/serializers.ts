import type { PaymentSourceListRecord } from './queries';

export function serializePaymentSourceEntry(paymentSource: PaymentSourceListRecord) {
	return paymentSource;
}

export function serializePaymentSourcesResponse(paymentSources: PaymentSourceListRecord[]) {
	return {
		PaymentSources: paymentSources.map(serializePaymentSourceEntry),
	};
}
