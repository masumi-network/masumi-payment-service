/**
 * What a funds-lock pass does with the purchase requests no free wallet took.
 *
 * Shared by the V1 and V2 batchers, which pair requests with wallets the same
 * way. A request is parked as InsufficientFunds only when every eligible
 * purchasing wallet was free this tick and none could pay: a busy wallet frees
 * up with its funds intact, so it must suppress the permanent error instead of
 * counting as absent. While a busy wallet keeps the request alive, the closest
 * fit miss is written onto the pending action, so the operator sees the
 * shortage and the timeout can name it.
 */
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HotWalletType, PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';
import {
	type FundsFitMiss,
	pickClosestFundsFitMiss,
	recordFundsFitMiss,
} from '@/services/transactions/tx-sync/funds-fit-miss';

export interface UnpairedPurchaseRequest {
	id: string;
	nextActionId: string;
	inputHash: string | null;
	isLimitedToHotWallets: boolean;
	HotWalletLimit: ReadonlyArray<{ id: string }>;
	NextAction: { errorNote: string | null };
}

export async function settleUnpairedPurchaseRequests(params: {
	paymentSourceId: string;
	requests: readonly UnpairedPurchaseRequest[];
	/** The purchasing wallets this pass evaluated: the ones that were free. */
	freeWallets: ReadonlyArray<{ id: string }>;
	walletFitMisses: readonly FundsFitMiss[];
}): Promise<void> {
	const { paymentSourceId, requests, freeWallets, walletFitMisses } = params;
	// Count every wallet, including ones busy with a pending transaction or
	// locked by a concurrent run.
	const allWalletCount = await prisma.hotWallet.count({
		where: { deletedAt: null, type: HotWalletType.Purchasing, PaymentSource: { id: paymentSourceId } },
	});
	for (const request of requests) {
		const eligibleWalletCount = request.isLimitedToHotWallets
			? await prisma.hotWallet.count({
					where: {
						deletedAt: null,
						type: HotWalletType.Purchasing,
						PaymentSource: { id: paymentSourceId },
						id: { in: request.HotWalletLimit.map((wallet) => wallet.id) },
					},
				})
			: allWalletCount;
		const freeEligibleWalletCount = request.isLimitedToHotWallets
			? freeWallets.filter((wallet) => request.HotWalletLimit.some((limit) => limit.id === wallet.id)).length
			: freeWallets.length;
		if (eligibleWalletCount === freeEligibleWalletCount) {
			logger.warn('No wallets with funds found, going into error state for', {
				purchaseRequestId: request.id,
				eligibleWalletCount,
				eligiblePotentialCount: freeEligibleWalletCount,
			});
			await prisma.purchaseRequest.update({
				where: { id: request.id },
				data: {
					ActionHistory: { connect: { id: request.nextActionId } },
					NextAction: {
						create: {
							requestedAction: PurchasingAction.WaitingForManualAction,
							errorType: PurchaseErrorType.InsufficientFunds,
							errorNote:
								request.inputHash == null
									? 'Purchase request has no input hash and not enough funds in wallets'
									: 'Not enough funds in wallets',
						},
					},
				},
			});
			continue;
		}
		const closestMiss = pickClosestFundsFitMiss(walletFitMisses, request.id);
		if (closestMiss !== null) {
			await recordFundsFitMiss({
				nextActionId: request.nextActionId,
				currentErrorNote: request.NextAction.errorNote,
				miss: closestMiss,
				freeWalletCount: freeEligibleWalletCount,
				eligibleWalletCount,
			});
		}
	}
}
