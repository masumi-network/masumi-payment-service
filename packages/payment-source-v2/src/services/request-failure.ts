import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { writePaymentErrorTransition, writePurchaseErrorTransition } from '@/services/shared/error-transition';

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
		await prisma.$transaction((tx) =>
			writePaymentErrorTransition(tx, {
				requestId: request.id,
				nextActionId: request.nextActionId,
				errorNote: config.errorNotePrefix + interpretBlockchainError(error),
				unlockWallet,
				...(config.carryResultHash ? { resultHash: request.NextAction?.resultHash ?? null } : {}),
			}),
		);
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
		options: { unlockWallet?: boolean } = {},
	): Promise<void> {
		// See the payment marker for why a caller passes unlockWallet=false: the
		// unlock here clears by wallet id, so a caller that fences its own unlock
		// on the `lockedAt` it claimed has to keep that fence and do it itself.
		logger.error(`${config.logMessage} ${request.id}`, { error });
		await prisma.$transaction((tx) =>
			writePurchaseErrorTransition(tx, {
				requestId: request.id,
				nextActionId: request.nextActionId,
				errorNote: config.errorNotePrefix + interpretBlockchainError(error),
				unlockWallet: options.unlockWallet ?? true,
			}),
		);
	};
}

/** Best-effort wallet unlock; `serviceLabel` names the calling service in the warn log. */
export function makeHotWalletUnlocker(serviceLabel: string) {
	/**
	 * @param expectedLockedAt the `lockedAt` this caller claimed. Pass it, and
	 * the clear applies only to that lock.
	 */
	return async function unlockHotWallet(walletId: string, expectedLockedAt?: Date | null): Promise<void> {
		try {
			// `lockPurpose: null` is the fence, not a filter for tidiness. A Hydra L1
			// deposit claims the same wallet with a purpose set, holds it across a full
			// L1 confirmation and never attaches a PendingTransaction — so a tick whose
			// own lock was reaped as stale would otherwise clear a carve's lock here,
			// and the next batch builds over the carve's inputs.
			//
			// `lockedAt` is the second half of the same fence, and it is the one that
			// catches a sibling tick. A batch's validate loop can outlive
			// `WALLET_LOCK_TIMEOUT_INTERVAL` on its own — seven items deferring
			// through a [0, 5s, 10s, 20s] schedule is 245s of sleep before any
			// Blockfrost time — so the orphan-lock reaper legitimately clears this
			// tick's claim, the next tick takes the wallet, and this one then arrives
			// here and frees a claim that is no longer its own. Two batches then
			// build over the same UTxOs and one dies on chain as `BadInputsUTxO`,
			// which for a script spend is a phase-2 failure and burns the collateral.
			await prisma.hotWallet.updateMany({
				where: {
					id: walletId,
					deletedAt: null,
					lockPurpose: null,
					...(expectedLockedAt == null ? {} : { lockedAt: expectedLockedAt }),
				},
				data: { lockedAt: null },
			});
		} catch (error) {
			logger.warn(`Failed to unlock V2 ${serviceLabel} hot wallet`, { error, walletId });
		}
	};
}
