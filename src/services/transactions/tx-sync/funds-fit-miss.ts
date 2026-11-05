/**
 * Leave a trace when a lock pass cannot pay a purchase for lack of funds.
 *
 * The V1 and V2 funds-lock passes only park a request as InsufficientFunds
 * when every eligible purchasing wallet was free that tick. While one wallet
 * is busy the request retries, and if the funds never arrive it times out
 * with errorType Unknown and a note that names no cause. The daily USDM
 * purchases on one payment source failed this way for a week, with the
 * balances in plain view the whole time.
 *
 * The pass therefore writes what it saw onto the request's pending action.
 * The action keeps requestedAction FundsLockingRequested and errorType null,
 * so the pass picks the request up again, and the timeout reads the note to
 * label the failure InsufficientFunds (see timeout-note.ts).
 */
import { prisma } from '@masumi/payment-core/db';
import { PurchasingAction } from '@/generated/prisma/client';
import { buildFundsFitMissNote } from './timeout-note';

export interface FundsFitMiss {
	walletId: string;
	purchaseRequestId: string;
	unit: string;
	requiredAmount: string;
	availableAmount: string;
}

/** The miss that came closest for this request: the one with the most of the missing unit. */
export function pickClosestFundsFitMiss(
	misses: readonly FundsFitMiss[],
	purchaseRequestId: string,
): FundsFitMiss | null {
	let closest: FundsFitMiss | null = null;
	for (const miss of misses) {
		if (miss.purchaseRequestId !== purchaseRequestId) continue;
		if (closest === null || BigInt(miss.availableAmount) > BigInt(closest.availableAmount)) closest = miss;
	}
	return closest;
}

/**
 * Write the fit-miss note onto the request's pending lock action.
 *
 * Guarded on the action still being the pending lock with no error, so a
 * concurrent writer that advanced or failed the request is never overwritten.
 * A note equal to the current one is not rewritten.
 */
export async function recordFundsFitMiss(params: {
	nextActionId: string;
	currentErrorNote: string | null;
	miss: FundsFitMiss;
	freeWalletCount: number;
	eligibleWalletCount: number;
}): Promise<void> {
	const note = buildFundsFitMissNote({
		unit: params.miss.unit,
		requiredAmount: params.miss.requiredAmount,
		availableAmount: params.miss.availableAmount,
		freeWalletCount: params.freeWalletCount,
		eligibleWalletCount: params.eligibleWalletCount,
	});
	if (note === params.currentErrorNote) return;
	await prisma.purchaseActionData.updateMany({
		where: { id: params.nextActionId, requestedAction: PurchasingAction.FundsLockingRequested, errorType: null },
		data: { errorNote: note },
	});
}
