import type { PaymentSourceExtendedListRecord } from './queries';
import type { WalletCounts } from './queries';

const EMPTY_WALLET_COUNTS: WalletCounts = { PurchasingWalletsCount: 0, SellingWalletsCount: 0 };

export function serializePaymentSourceExtendedEntry(
	paymentSource: PaymentSourceExtendedListRecord,
	walletCounts: WalletCounts = EMPTY_WALLET_COUNTS,
) {
	return {
		...paymentSource,
		PurchasingWalletsCount: walletCounts.PurchasingWalletsCount,
		SellingWalletsCount: walletCounts.SellingWalletsCount,
	};
}

export function serializePaymentSourceExtendedResponse(
	paymentSources: PaymentSourceExtendedListRecord[],
	walletCountsByPaymentSource: Map<string, WalletCounts>,
) {
	return {
		ExtendedPaymentSources: paymentSources.map((paymentSource) =>
			serializePaymentSourceExtendedEntry(paymentSource, walletCountsByPaymentSource.get(paymentSource.id)),
		),
	};
}
