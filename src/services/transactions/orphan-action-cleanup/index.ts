// Daily-ish GC for orphaned PaymentActionData / PurchaseActionData rows.
//
// The V2 batch services (submit-result, collection, authorize-refund,
// authorize-withdrawal, collect-refund, request-refund, batch-payments)
// pre-allocate an `*Initiated` action row inside a Serializable
// pre-submit transaction. When the post-submit rollback drift-check
// detects state-machine drift (another worker advanced the request's
// NextAction between our pre-submit and post-submit), the rollback
// path deliberately LEAKS the orphan action row instead of deleting it
// — `safeDeleteOrphanNextPaymentAction` would risk corrupting another
// worker's history if its drift detection ever mis-fired. Leaking a
// row is cheap; deleting one referenced elsewhere is corruption.
//
// Over many ticks these orphans accumulate. This service prunes rows
// that:
//   - have no NextAction backref (no request points at them as current),
//   - have no history backref (no request points at them as historical),
//   - carry an `*Initiated` requestedAction (only batch pre-submit
//     allocates these, so other action shapes are out of scope), and
//   - are older than `ORPHAN_ACTION_CLEANUP_MIN_AGE_HOURS` (defends
//     against deleting an in-flight pre-submit allocation that hasn't
//     been linked to its request yet because the pre-submit transaction
//     hasn't committed).
//
// Configuration:
//   - ORPHAN_ACTION_CLEANUP_INTERVAL_SECONDS (default 86400 = 24h)
//   - ORPHAN_ACTION_CLEANUP_MIN_AGE_HOURS    (default 72h)
//   - ORPHAN_ACTION_CLEANUP_BATCH_SIZE       (default 500)

import { PaymentAction, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { CONFIG } from '@masumi/payment-core/config';

const PAYMENT_INITIATED_ACTIONS: PaymentAction[] = [
	PaymentAction.SubmitResultInitiated,
	PaymentAction.WithdrawInitiated,
	PaymentAction.AuthorizeRefundInitiated,
];

const PURCHASE_INITIATED_ACTIONS: PurchasingAction[] = [
	PurchasingAction.FundsLockingInitiated,
	PurchasingAction.SetRefundRequestedInitiated,
	PurchasingAction.UnSetRefundRequestedInitiated,
	PurchasingAction.WithdrawRefundInitiated,
	PurchasingAction.AuthorizeWithdrawalInitiated,
];

export async function cleanupOrphanActionData(): Promise<void> {
	const minAgeMs = CONFIG.ORPHAN_ACTION_CLEANUP_MIN_AGE_HOURS * 3600 * 1000;
	const cutoff = new Date(Date.now() - minAgeMs);
	const batchSize = CONFIG.ORPHAN_ACTION_CLEANUP_BATCH_SIZE;

	let totalPaymentDeleted = 0;
	let totalPurchaseDeleted = 0;

	// --- PaymentActionData ---
	// Loop until a batch returns < batchSize, so a one-time backlog from
	// a long-running deployment gets cleared without holding the
	// scheduler tick open indefinitely. Each iteration is a separate
	// transaction so per-batch errors don't undo prior progress.
	for (;;) {
		const orphans = await prisma.paymentActionData.findMany({
			where: {
				createdAt: { lt: cutoff },
				requestedAction: { in: PAYMENT_INITIATED_ACTIONS },
				PaymentRequestCurrent: { is: null },
				paymentRequestHistoryId: null,
			},
			select: { id: true },
			take: batchSize,
		});
		if (orphans.length === 0) break;

		const ids = orphans.map((r) => r.id);
		try {
			const result = await prisma.paymentActionData.deleteMany({
				where: {
					id: { in: ids },
					// Re-check the orphan predicate at delete time. A new
					// PaymentRequest could have linked one of these ids
					// between the find and the delete. The relational
					// constraint would error on delete anyway, but
					// re-asserting here avoids the Prisma error path and
					// keeps the deleteMany count accurate.
					PaymentRequestCurrent: { is: null },
					paymentRequestHistoryId: null,
				},
			});
			totalPaymentDeleted += result.count;
		} catch (err) {
			logger.warn('orphan-action-cleanup: PaymentActionData batch delete failed', {
				error: err instanceof Error ? err.message : String(err),
				batchSize: orphans.length,
			});
			break;
		}
		if (orphans.length < batchSize) break;
	}

	// --- PurchaseActionData ---
	for (;;) {
		const orphans = await prisma.purchaseActionData.findMany({
			where: {
				createdAt: { lt: cutoff },
				requestedAction: { in: PURCHASE_INITIATED_ACTIONS },
				PurchaseRequestCurrent: { is: null },
				purchaseRequestHistoryId: null,
			},
			select: { id: true },
			take: batchSize,
		});
		if (orphans.length === 0) break;

		const ids = orphans.map((r) => r.id);
		try {
			const result = await prisma.purchaseActionData.deleteMany({
				where: {
					id: { in: ids },
					PurchaseRequestCurrent: { is: null },
					purchaseRequestHistoryId: null,
				},
			});
			totalPurchaseDeleted += result.count;
		} catch (err) {
			logger.warn('orphan-action-cleanup: PurchaseActionData batch delete failed', {
				error: err instanceof Error ? err.message : String(err),
				batchSize: orphans.length,
			});
			break;
		}
		if (orphans.length < batchSize) break;
	}

	logger.info('orphan-action-cleanup: completed', {
		paymentRowsDeleted: totalPaymentDeleted,
		purchaseRowsDeleted: totalPurchaseDeleted,
		cutoff: cutoff.toISOString(),
		minAgeHours: CONFIG.ORPHAN_ACTION_CLEANUP_MIN_AGE_HOURS,
	});
}
