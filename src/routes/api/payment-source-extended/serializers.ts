import { PaymentSourceType } from '@/generated/prisma/client';
import { classifyV2SourceSync, type V2SourceSyncStatus } from '@/utils/v2-contract-sync';
import type { PaymentSourceExtendedListRecord } from './queries';
import type { WalletCounts } from './queries';

const EMPTY_WALLET_COUNTS: WalletCounts = { PurchasingWalletsCount: 0, SellingWalletsCount: 0 };

export function serializePaymentSourceExtendedEntry(
	paymentSource: PaymentSourceExtendedListRecord,
	walletCounts: WalletCounts = EMPTY_WALLET_COUNTS,
) {
	// Only Web3CardanoV2 sources have a current-contract notion here; V1/other
	// sources are reported in_sync (their policyId is derived differently and must
	// not be compared against the V2 defaults).
	const contractSyncStatus: V2SourceSyncStatus =
		paymentSource.paymentSourceType === PaymentSourceType.Web3CardanoV2
			? classifyV2SourceSync(paymentSource)
			: 'in_sync';
	return {
		...paymentSource,
		contractSyncStatus,
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
