import { splitWalletsByType } from '@/utils/shared/transformers';
import type { PaymentSourceExtendedListRecord } from './queries';
import { serializeLowBalanceSummary } from '@/services/wallets';

export function serializePaymentSourceExtendedEntry(paymentSource: PaymentSourceExtendedListRecord) {
	const { HotWallets, ...rest } = paymentSource;
	const serializedWallets = HotWallets.map(({ LowBalanceRules, ...wallet }) => ({
		...wallet,
		LowBalanceSummary: serializeLowBalanceSummary(LowBalanceRules),
	}));
	return {
		...rest,
		...splitWalletsByType(serializedWallets),
	};
}

export function serializePaymentSourceExtendedResponse(paymentSources: PaymentSourceExtendedListRecord[]) {
	return {
		ExtendedPaymentSources: paymentSources.map(serializePaymentSourceExtendedEntry),
	};
}
