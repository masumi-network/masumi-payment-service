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
			//    nextActionId; updateMany cannot express relation writes. Batch via
			//    Promise.all so the per-row latency overlaps rather than serializes
			//    inside the outer $transaction.
			const paymentRequests = await tx.paymentRequest.findMany({
				where: { currentTransactionId: transactionId },
				select: { id: true, nextActionId: true },
			});
			await Promise.all(
				paymentRequests.map((request) =>
					tx.paymentRequest.update({
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
					}),
				),
			);

			// 3. PurchaseRequests pointing at this tx. Same per-row constraint as
			//    PaymentRequests — batched via Promise.all.
			const purchaseRequests = await tx.purchaseRequest.findMany({
				where: { currentTransactionId: transactionId },
				select: { id: true, nextActionId: true },
			});
			await Promise.all(
				purchaseRequests.map((request) =>
					tx.purchaseRequest.update({
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
					}),
				),
			);

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
			await Promise.all(
				registryRequests.map(async (request) => {
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
						// second failure on the same row.
						const composedError =
							request.error && request.error.length > 0
								? `${ERROR_NOTE_PHASE_2}; prior: ${request.error}`
								: ERROR_NOTE_PHASE_2;
						await tx.registryRequest.update({
							where: { id: request.id },
							data: {
								state: nextState,
								registrationStateLastChangedAt: new Date(),
								error: composedError,
							},
						});
					}
				}),
			);

			// 5. InboxAgentRegistrationRequests pointing at this tx — same terminal mapping.
			const inboxRequests = await tx.inboxAgentRegistrationRequest.findMany({
				where: { currentTransactionId: transactionId },
				select: { id: true, state: true, error: true },
			});
			await Promise.all(
				inboxRequests.map(async (request) => {
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
						const composedError =
							request.error && request.error.length > 0
								? `${ERROR_NOTE_PHASE_2}; prior: ${request.error}`
								: ERROR_NOTE_PHASE_2;
						await tx.inboxAgentRegistrationRequest.update({
							where: { id: request.id },
							data: {
								state: nextState,
								registrationStateLastChangedAt: new Date(),
								error: composedError,
							},
						});
					}
				}),
			);

			// 6. Hot-wallet unlock — atomic with the propagation. Without this, a
			//    crash between the propagation $transaction commit and the
			//    caller-side `hotWallet.update` would leave wallets locked with
			//    every dependent request already advanced to
			//    WaitingForManualAction; wallet-timeouts would re-discover the
			//    same phase-2 failure each tick and re-propagate (the dependent
			//    advances are guarded, so they no-op, but the wallet disconnect
			//    branch would fire every tick at ERROR level).
			//
			//    Per-wallet update — pendingTransactionId is unique-keyed so the
			//    disconnect cannot be expressed via updateMany without ambiguity.
			//    Use the same `deletedAt: null` guard as every other hot-wallet
			//    write site for soft-delete safety.
			if (options.walletIdsToUnlock && options.walletIdsToUnlock.length > 0) {
				await Promise.all(
					options.walletIdsToUnlock.map((walletId) =>
						tx.hotWallet.update({
							where: { id: walletId, deletedAt: null },
							data: {
								PendingTransaction: { disconnect: true },
								lockedAt: null,
							},
						}),
					),
				);
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
		{ timeout: 30_000 },
	);
}
