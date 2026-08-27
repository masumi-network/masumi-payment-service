import { OnChainState, PaymentSourceType } from '@/generated/prisma/client';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import type { PayoutCompleteness, ReportPaymentSourceType } from './metrics';

export function getReportPayoutCompleteness(input: {
	paymentSourceType: ReportPaymentSourceType;
	onChainState: OnChainState | null;
	returnAddress: string | null;
	expectedWalletVkey: string | null;
	buyerCollateralReturnLovelace?: bigint | null;
	hasStoredPayoutEvidence?: boolean;
}): PayoutCompleteness {
	if (
		input.onChainState === OnChainState.DisputedWithdrawn &&
		input.buyerCollateralReturnLovelace !== undefined &&
		input.buyerCollateralReturnLovelace !== 0n
	) {
		return 'partial';
	}
	if (
		input.paymentSourceType === PaymentSourceType.Web3CardanoV1 &&
		input.onChainState === OnChainState.DisputedWithdrawn &&
		input.hasStoredPayoutEvidence !== true
	) {
		return 'partial';
	}
	if (
		input.paymentSourceType !== PaymentSourceType.Web3CardanoV2 ||
		input.onChainState !== OnChainState.DisputedWithdrawn
	) {
		return 'complete';
	}
	if (input.returnAddress == null || input.expectedWalletVkey == null) return 'partial';
	try {
		return resolvePaymentKeyHash(input.returnAddress) === input.expectedWalletVkey ? 'complete' : 'partial';
	} catch {
		return 'partial';
	}
}
