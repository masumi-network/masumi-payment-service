import { HotWalletType, PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

type UnfundedPurchase = {
	id: string;
	nextActionId: string;
	inputHash: string | null;
	isLimitedToHotWallets: boolean;
	HotWalletLimit: Array<{ id: string }>;
};

/**
 * Park purchases no wallet could fund as WaitingForManualAction + InsufficientFunds,
 * but only when every wallet they may use was evaluated this run.
 *
 * `evaluatedWalletIds` must leave out wallets whose funds are unknown this run
 * (for example a guarded wallet whose smart wallet could not be read). A wallet
 * busy with a pending transaction or locked by a concurrent run is not in it
 * either: it frees up with its funds intact, so it suppresses the error state.
 */
export async function parkUnfundedPurchases(params: {
	paymentSourceId: string;
	purchases: UnfundedPurchase[];
	evaluatedWalletIds: string[];
}) {
	const { paymentSourceId, purchases, evaluatedWalletIds } = params;
	const allWalletCount = await prisma.hotWallet.count({
		where: { deletedAt: null, type: HotWalletType.Purchasing, PaymentSource: { id: paymentSourceId } },
	});
	for (const paymentRequest of purchases) {
		const eligibleWalletCount = paymentRequest.isLimitedToHotWallets
			? await prisma.hotWallet.count({
					where: {
						deletedAt: null,
						type: HotWalletType.Purchasing,
						PaymentSource: { id: paymentSourceId },
						id: { in: paymentRequest.HotWalletLimit.map((hw) => hw.id) },
					},
				})
			: allWalletCount;
		const eligiblePotentialCount = paymentRequest.isLimitedToHotWallets
			? evaluatedWalletIds.filter((id) => paymentRequest.HotWalletLimit.some((hw) => hw.id === id)).length
			: evaluatedWalletIds.length;
		if (eligibleWalletCount != eligiblePotentialCount) continue;
		logger.warn('No wallets with funds found, going into error state for', {
			purchaseRequestId: paymentRequest.id,
			eligibleWalletCount,
			eligiblePotentialCount,
		});
		await prisma.purchaseRequest.update({
			where: { id: paymentRequest.id },
			data: {
				ActionHistory: { connect: { id: paymentRequest.nextActionId } },
				NextAction: {
					create: {
						requestedAction: PurchasingAction.WaitingForManualAction,
						errorType: PurchaseErrorType.InsufficientFunds,
						errorNote:
							paymentRequest.inputHash == null
								? 'Purchase request has no input hash and not enough funds in wallets'
								: 'Not enough funds in wallets',
					},
				},
			},
		});
	}
}
