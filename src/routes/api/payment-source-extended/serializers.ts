import { splitWalletsByType } from '@/utils/shared/transformers';
import type { PaymentSourceExtendedListRecord } from './queries';

export function serializePaymentSourceExtendedEntry(paymentSource: PaymentSourceExtendedListRecord) {
	const { HotWallets, ...rest } = paymentSource;
	return {
		...rest,
		...splitWalletsByType(HotWallets),
	};
}

export function serializePaymentSourceExtendedResponse(paymentSources: PaymentSourceExtendedListRecord[]) {
	return {
		ExtendedPaymentSources: paymentSources.map(serializePaymentSourceExtendedEntry),
	};
}
