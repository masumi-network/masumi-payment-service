import { splitWalletsByType } from '@/utils/shared/transformers';
import type { PaymentSourceListRecord } from './queries';

export function serializePaymentSourceEntry(paymentSource: PaymentSourceListRecord) {
	const { HotWallets, ...rest } = paymentSource;
	return {
		...rest,
		...splitWalletsByType(HotWallets),
	};
}

export function serializePaymentSourcesResponse(paymentSources: PaymentSourceListRecord[]) {
	return {
		PaymentSources: paymentSources.map(serializePaymentSourceEntry),
	};
}
