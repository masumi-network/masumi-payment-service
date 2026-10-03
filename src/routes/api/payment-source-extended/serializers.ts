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

/**
 * The list endpoint is read-authenticated so non-admin sessions can bootstrap
 * network/source selection, but `PaymentSourceConfig.rpcProviderApiKey` is an
 * operator secret (a billable Blockfrost project id). Strip it for anything
 * below admin — a Read key must never be able to walk away with it.
 */
export function serializePaymentSourceExtendedResponse(
	paymentSources: PaymentSourceExtendedListRecord[],
	walletCountsByPaymentSource: Map<string, WalletCounts>,
	includeRpcProviderApiKey: boolean,
) {
	return {
		ExtendedPaymentSources: paymentSources.map((paymentSource) => {
			const entry = serializePaymentSourceExtendedEntry(
				paymentSource,
				walletCountsByPaymentSource.get(paymentSource.id),
			);
			if (includeRpcProviderApiKey) {
				return entry;
			}
			return {
				...entry,
				PaymentSourceConfig: {
					rpcProvider: entry.PaymentSourceConfig.rpcProvider,
				},
			};
		}),
	};
}
