import { PaymentAction, PaymentErrorType, PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
// Import from the concrete module, not the '@/services/shared' barrel: the
// barrel transitively imports this package back, and the resulting cycle makes
// typed lint unable to resolve these call signatures.
import {
	connectPreviousAction,
	createNextPaymentAction,
	createNextPurchaseAction,
} from '@/services/shared/transition-writer';

/**
 * Factories for the per-service `markRequestFailed` / `unlockHotWallet`
 * helpers that every V2 batch service used to redefine. Each service builds
 * its own instance with its log message and error-note prefix; the DB state
 * transition (park in WaitingForManualAction, record the interpreted error,
 * optionally release the wallet lock) is identical everywhere.
 */
interface PaymentFailureConfig {
	/** e.g. 'Error authorizing V2 refund' — request id is appended. */
	logMessage: string;
	/** e.g. 'Authorizing refund failed: ' — interpreted error is appended. */
	errorNotePrefix: string;
	/**
	 * Carry the seller-supplied result hash forward onto the failure action so
	 * operator forensics preserve the originally-attempted submission
	 * (submit-result only).
	 */
	carryResultHash?: boolean;
}

export function makePaymentRequestFailureMarker(config: PaymentFailureConfig) {
	return async function markRequestFailed(
		request: { id: string; nextActionId: string; NextAction?: { resultHash: string | null } | null },
		error: unknown,
		options: { unlockWallet?: boolean } = {},
	): Promise<void> {
		// unlockWallet=true only when this failure OWNS the wallet lock
		// (single-item path). In the batch validation loop the shared wallet
		// lock must survive so a concurrent service can't lock the same wallet
		// and submit a conflicting tx from the same UTxO set while this batch
		// keeps building the remaining items; the batch's terminal paths
		// release it instead.
		const unlockWallet = options.unlockWallet ?? true;
		logger.error(`${config.logMessage} ${request.id}`, { error });
		await prisma.paymentRequest.update({
			where: { id: request.id },
			data: {
				...connectPreviousAction(request.nextActionId),
				...createNextPaymentAction(PaymentAction.WaitingForManualAction, {
					...(config.carryResultHash ? { resultHash: request.NextAction?.resultHash ?? null } : {}),
					errorType: PaymentErrorType.Unknown,
					errorNote: config.errorNotePrefix + interpretBlockchainError(error),
				}),
				...(unlockWallet ? { SmartContractWallet: { update: { lockedAt: null } } } : {}),
			},
		});
	};
}

interface PurchaseFailureConfig {
	logMessage: string;
	errorNotePrefix: string;
}

export function makePurchaseRequestFailureMarker(config: PurchaseFailureConfig) {
	return async function markRequestFailed(
		request: { id: string; nextActionId: string },
		error: unknown,
	): Promise<void> {
		logger.error(`${config.logMessage} ${request.id}`, { error });
		await prisma.purchaseRequest.update({
			where: { id: request.id },
			data: {
				...connectPreviousAction(request.nextActionId),
				...createNextPurchaseAction(PurchasingAction.WaitingForManualAction, {
					errorType: PurchaseErrorType.Unknown,
					errorNote: config.errorNotePrefix + interpretBlockchainError(error),
				}),
				SmartContractWallet: { update: { lockedAt: null } },
			},
		});
	};
}

/** Best-effort wallet unlock; `serviceLabel` names the calling service in the warn log. */
export function makeHotWalletUnlocker(serviceLabel: string) {
	return async function unlockHotWallet(walletId: string): Promise<void> {
		try {
			await prisma.hotWallet.update({
				where: { id: walletId, deletedAt: null },
				data: { lockedAt: null },
			});
		} catch (error) {
			logger.warn(`Failed to unlock V2 ${serviceLabel} hot wallet`, { error, walletId });
		}
	};
}
