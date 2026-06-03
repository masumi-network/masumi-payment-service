// Phase-2 failure propagation.
//
// When a submitted Cardano tx lands on chain but the script rejects
// (`valid_contract = false`), the chain consumes only the tx's collateral and
// produces NO new script-address UTxOs. Our tx-sync handlers only fire when a
// new UTxO appears, so they cannot observe the failure — leaving the shared
// `Transaction` row in `Pending` and every dependent request row stuck in
// `*Initiated`.
//
// This helper is invoked by the wallet-timeouts cron (`updateWalletTransactionHash`)
// after it confirms a tx is on chain AND fetches `valid_contract = false` from
// Blockfrost. It:
//   1. Marks the Transaction as failed (`FailedViaTimeout`, `validContract=false`).
//   2. Walks every PaymentRequest / PurchaseRequest with `currentTransactionId`
//      pointing at this tx, advances NextAction → `WaitingForManualAction`.
//   3. Walks every RegistryRequest / InboxAgentRegistrationRequest with
//      `currentTransactionId` pointing at this tx, advances the registration
//      state to its terminal `*Failed` variant.
//
// All writes happen in one Prisma `$transaction` so the failure is observed
// atomically; serialization conflicts get retried by the caller's outer
// retry wrapper.

import { prisma } from '@masumi/payment-core/db';
import {
	PaymentAction,
	PaymentErrorType,
	PurchaseErrorType,
	PurchasingAction,
	RegistrationState,
	TransactionStatus,
} from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';

const ERROR_NOTE_PHASE_2 = 'On-chain phase-2 validation failed (script rejected, collateral consumed)';

// Hard cap on composed-error length. State machine should bound the chain to
// ~2-3 cycles per row before reaching a terminal state, but a buggy state
// transition could let the prepend chain grow unbounded. Cap defensively;
// truncate from the OLD end (keep the most recent failure context) and append
// a marker so it's obvious history was elided.
const MAX_COMPOSED_ERROR_LEN = 2000;
function composePhase2Error(priorError: string | null): string {
	if (priorError == null || priorError.length === 0) return ERROR_NOTE_PHASE_2;
	const composed = `${ERROR_NOTE_PHASE_2}; prior: ${priorError}`;
	if (composed.length <= MAX_COMPOSED_ERROR_LEN) return composed;
	const ellipsis = '… [truncated]';
	return composed.slice(0, MAX_COMPOSED_ERROR_LEN - ellipsis.length) + ellipsis;
}

/**
 * Mark a Transaction row + every dependent request as phase-2-failed.
 *
 * Idempotent: if the Transaction is already in a terminal status, the writes
 * are no-ops thanks to `where: { status: TransactionStatus.Pending }` guards.
 *
 * Optional `walletIdsToUnlock`: hot-wallet ids that should be unlocked
 * (disconnect PendingTransaction + clear lockedAt) within the SAME inner
 * `$transaction`. The caller previously did this outside the propagation
 * transaction; if the outer process died between the two writes the wallet
 * stayed locked forever despite dependent requests being advanced to
 * WaitingForManualAction — wallet-timeouts' next tick would re-discover
 * the same phase-2 failure and re-propagate, multiplying error noise.
 * Folding the unlock into this $transaction makes it atomic with the
 * dependent-request advance.
 *
 * Uses per-row `updateMany` where the data is uniform across rows (the
 * paymentRequest / purchaseRequest path can't use bulk updateMany because
 * each row's `ActionHistory` connection points at a different prior
 * nextActionId — Prisma's updateMany doesn't accept relation operators).
 * The outer wrapper timeout is 30s to accommodate the per-row writes when
 * many dependents share one phase-2-failed batch tx.
 */
export async function markTransactionPhase2Failed(
	transactionId: string,
	txHash: string,
	options: { walletIdsToUnlock?: string[] } = {},
): Promise<void> {
	await prisma.$transaction(
		async (tx) => {
			// 1. Transaction row — guard against double-marking.
			const updated = await tx.transaction.updateMany({
				where: { id: transactionId, status: TransactionStatus.Pending },
				data: {
					status: TransactionStatus.FailedViaTimeout,
					validContract: false,
				},
			});
			if (updated.count === 0) {
				// Another worker already advanced this row; nothing to propagate.
				logger.info(`Phase-2 propagation skipped — Transaction ${transactionId} no longer Pending`, {
					txHash,
				});
				return;
			}

			// 2. PaymentRequests pointing at this tx. Per-row update because each
			//    row's ActionHistory.connect references a distinct prior
			//    nextActionId; updateMany cannot express relation writes.
			const paymentRequests = await tx.paymentRequest.findMany({
				where: { currentTransactionId: transactionId },
				select: { id: true, nextActionId: true },
			});
			// intentional sequential — Prisma serializes interactive-tx queries on a single connection
			for (const request of paymentRequests) {
				await tx.paymentRequest.update({
					where: { id: request.id },
					data: {
						ActionHistory: { connect: { id: request.nextActionId } },
						NextAction: {
							create: {
								requestedAction: PaymentAction.WaitingForManualAction,
								errorType: PaymentErrorType.Unknown,
								errorNote: ERROR_NOTE_PHASE_2,
							},
						},
					},
				});
			}

			// 3. PurchaseRequests pointing at this tx. Same per-row constraint as
			//    PaymentRequests.
			const purchaseRequests = await tx.purchaseRequest.findMany({
				where: { currentTransactionId: transactionId },
				select: { id: true, nextActionId: true },
			});
			// intentional sequential — Prisma serializes interactive-tx queries on a single connection
			for (const request of purchaseRequests) {
				await tx.purchaseRequest.update({
					where: { id: request.id },
					data: {
						ActionHistory: { connect: { id: request.nextActionId } },
						NextAction: {
							create: {
								requestedAction: PurchasingAction.WaitingForManualAction,
								errorType: PurchaseErrorType.Unknown,
								errorNote: ERROR_NOTE_PHASE_2,
							},
						},
					},
				});
			}

			// 4. RegistryRequests pointing at this tx. The state machine here has no
			//    "ManualAction" pause: a failed mint/burn is terminal — operator must
			//    re-create the registration. Map *Initiated → *Failed; leave any other
			//    state (Confirmed, already-Failed) alone. Any non-Initiated state on a
			//    phase-2 failure is unexpected (state should never advance to Confirmed
			//    before tx-sync observes a new UTxO, which cannot exist on a phase-2
			//    rejection) — log a warn so we can spot drift.
			const registryRequests = await tx.registryRequest.findMany({
				where: { currentTransactionId: transactionId },
				select: { id: true, state: true, error: true },
			});
			// intentional sequential — Prisma serializes interactive-tx queries on a single connection
			for (const request of registryRequests) {
				let nextState: RegistrationState | null = null;
				if (request.state === RegistrationState.RegistrationInitiated) {
					nextState = RegistrationState.RegistrationFailed;
				} else if (request.state === RegistrationState.DeregistrationInitiated) {
					nextState = RegistrationState.DeregistrationFailed;
				} else {
					logger.warn(`Phase-2 failure observed on RegistryRequest in unexpected state`, {
						transactionId,
						txHash,
						registryRequestId: request.id,
						state: request.state,
						priorError: request.error,
					});
				}
				if (nextState != null) {
					// Preserve any prior error context — append rather than overwrite — so
					// operator forensics keep the original failure note when this is the
					// second failure on the same row. Capped via composePhase2Error so a
					// runaway state-transition bug can't unbounded-grow the field.
					await tx.registryRequest.update({
						where: { id: request.id },
						data: {
							state: nextState,
							registrationStateLastChangedAt: new Date(),
							error: composePhase2Error(request.error),
						},
					});
				}
			}

			// 5. InboxAgentRegistrationRequests pointing at this tx — same terminal mapping.
			const inboxRequests = await tx.inboxAgentRegistrationRequest.findMany({
				where: { currentTransactionId: transactionId },
				select: { id: true, state: true, error: true },
			});
			// intentional sequential — Prisma serializes interactive-tx queries on a single connection
			for (const request of inboxRequests) {
				let nextState: RegistrationState | null = null;
				if (request.state === RegistrationState.RegistrationInitiated) {
					nextState = RegistrationState.RegistrationFailed;
				} else if (request.state === RegistrationState.DeregistrationInitiated) {
					nextState = RegistrationState.DeregistrationFailed;
				} else {
					logger.warn(`Phase-2 failure observed on InboxAgentRegistrationRequest in unexpected state`, {
						transactionId,
						txHash,
						inboxRequestId: request.id,
						state: request.state,
						priorError: request.error,
					});
				}
				if (nextState != null) {
					await tx.inboxAgentRegistrationRequest.update({
						where: { id: request.id },
						data: {
							state: nextState,
							registrationStateLastChangedAt: new Date(),
							error: composePhase2Error(request.error),
						},
					});
				}
			}

			// 6. Hot-wallet unlock — atomic with the propagation. Without this, a
			//    crash between the propagation $transaction commit and the
			//    caller-side `hotWallet.update` would leave wallets locked with
			//    every dependent request already advanced to
			//    WaitingForManualAction; wallet-timeouts would re-discover the
			//    same phase-2 failure each tick and re-propagate (the dependent
			//    advances are guarded, so they no-op, but the wallet disconnect
			//    branch would fire every tick at ERROR level).
			//
			//    Use `updateMany`, NOT `update`: a wallet that was soft-deleted or
			//    otherwise no longer matches `{ id, deletedAt: null }` makes
			//    `update` throw P2025, which would abort and ROLL BACK this whole
			//    Serializable propagation — leaving the Transaction Pending and every
			//    dependent request stuck in `*Initiated`, so wallet-timeouts
			//    re-discovers the same phase-2 failure and re-propagates (ERROR-
			//    logging) every tick forever. `updateMany` returns `{ count: 0 }`
			//    instead of throwing, so the unlock is best-effort while the
			//    dependent-request advance above still commits. Clearing the scalar
			//    `pendingTransactionId` is the updateMany-compatible equivalent of
			//    `PendingTransaction: { disconnect: true }` (relation operators are
			//    not allowed in updateMany) and matches the funding-reconciliation
			//    revert site. Genuine DB errors still throw and propagate.
			//    Use the same `deletedAt: null` guard as every other hot-wallet
			//    write site for soft-delete safety.
			if (options.walletIdsToUnlock && options.walletIdsToUnlock.length > 0) {
				// Dedup defensively: callers can collect ids from overlapping
				// sources (the failing tx's BlocksWallet plus dependent
				// requests' SmartContractWallet relations) and the same id can
				// appear more than once. Issuing two updates against the same
				// row inside a single interactive transaction is wasted work
				// and risks confusing audit trails.
				const uniqueWalletIds = Array.from(new Set(options.walletIdsToUnlock));
				// intentional sequential — Prisma serializes interactive-tx queries on a single connection
				for (const walletId of uniqueWalletIds) {
					await tx.hotWallet.updateMany({
						where: { id: walletId, deletedAt: null },
						data: {
							pendingTransactionId: null,
							lockedAt: null,
						},
					});
				}
			}

			logger.error(`Propagated phase-2 failure for tx ${txHash}`, {
				transactionId,
				paymentRequests: paymentRequests.length,
				purchaseRequests: purchaseRequests.length,
				registryRequests: registryRequests.length,
				inboxRequests: inboxRequests.length,
				walletsUnlocked: options.walletIdsToUnlock?.length ?? 0,
			});
		},
		{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
	);
}
