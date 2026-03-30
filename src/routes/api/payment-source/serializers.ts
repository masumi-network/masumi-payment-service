import { splitWalletsByType } from '@/utils/shared/transformers';
import type { PaymentSourceListRecord } from './queries';
import { serializeLowBalanceSummary } from '@/services/wallets';

export function serializePaymentSourceEntry(paymentSource: PaymentSourceListRecord) {
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

export function serializePaymentSourcesResponse(paymentSources: PaymentSourceListRecord[]) {
	return {
		PaymentSources: paymentSources.map(serializePaymentSourceEntry),
	};
}
