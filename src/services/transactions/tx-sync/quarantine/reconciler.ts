import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { createApiClient, withJobLock } from '@/services/shared';
import { CONFIG } from '@masumi/payment-core/config';
import { Mutex } from 'async-mutex';
import { getExtendedTxInformation } from '../blockchain';
import {
	claimQuarantinedTransaction,
	compareQuarantineChainPosition,
	deferClaimedQuarantine,
	errorToText,
	fenceQuarantineClaimWrite,
	getQuarantineHealth,
	isQuarantineLeaseLostError,
	markClaimedQuarantineNeedsOperator,
	QuarantineClaim,
	QUARANTINE_CHAIN_ORDER,
	recordQuarantineAttempt,
	releaseQuarantineClaim,
	resolveQuarantinedTransaction,
} from './index';
import { processTransactionData } from '../service';
import { getChainErrorStatus } from '@/services/shared/chain-tx-lookup';

/** How many quarantined transactions one tick will attempt. */
const MAX_PER_TICK = 25;

/** Re-check cadence while waiting for a shallow tx to reach the threshold. */
const CONFIRMATION_WAIT_MS = 60 * 1000;

/**
 * A quarantined transaction is retried until it succeeds, is found to no longer
 * exist on chain, or is classified terminal. Deciding which is which is the
 * whole job — "retry forever" and "give up immediately" are both wrong.
 */
export type QuarantineOutcome = 'resolved' | 'retry' | 'terminal';

export function isBlockingQuarantineOutcome(outcome: QuarantineOutcome): boolean {
	return outcome === 'retry' || outcome === 'terminal';
}

/**
 * Classifies a failure into what should happen next.
 *
 * Blockfrost returns 404 both for indexing lag and for a transaction absent
 * after rollback. Repeated responses from the same provider are not independent
 * rollback evidence, so callers always retry them and eventually escalate.
 */
export function classifyQuarantineError(error: unknown): 'not-found' | 'transient' | 'terminal' {
	const status = getChainErrorStatus(error);
	if (status === 404) return 'not-found';
	if (status === 408 || status === 425 || status === 429 || (status != null && status >= 500)) {
		return 'transient';
	}
	if (status != null) return 'terminal';

	const text = errorToText(error).toLowerCase();

	if (text.includes('404') || text.includes('not found')) {
		return 'not-found';
	}
	if (
		text.includes('429') ||
		text.includes('too many requests') ||
		text.includes('timeout') ||
		text.includes('etimedout') ||
		text.includes('econnreset') ||
		text.includes('socket hang up') ||
		text.includes('enotfound') ||
		text.includes('500') ||
		text.includes('502') ||
		text.includes('503') ||
		text.includes('504')
	) {
		return 'transient';
	}

	// Anything else is assumed deterministic — a CBOR/datum parse failure, a
	// schema mismatch, a bug. Retrying those a thousand times helps nobody and
	// buries the signal, so they escalate to an operator instead.
	return 'terminal';
}

const quarantineMutex = new Mutex();

/**
 * Retries transactions the scanner could not handle.
 *
 * Runs independently of the scanner so a stuck transaction never blocks the
 * checkpoint, and the checkpoint never leaves one behind unnoticed.
 */
export async function reconcileQuarantinedTransactions(): Promise<void> {
	await withJobLock(quarantineMutex, 'tx-sync-quarantine-reconciler', async () => {
		// Pick one head per source BEFORE applying due/operator filters. Filtering
		// first lets 25 due descendants of one backed-off predecessor fill the
		// batch forever and starve every other payment source.
		const sourceHeads = await prisma.txSyncQuarantine.findMany({
			where: {
				resolvedAt: null,
				// Soft-deleted payment sources keep their rows (the FK cascade only
				// fires on hard delete); without this filter their entries would
				// cycle through the backoff ladder forever.
				PaymentSource: { deletedAt: null },
			},
			distinct: ['paymentSourceId'],
			orderBy: [{ paymentSourceId: 'asc' as const }, ...QUARANTINE_CHAIN_ORDER],
			include: {
				PaymentSource: { include: { PaymentSourceConfig: true } },
			},
		});
		const now = Date.now();
		const due = sourceHeads
			// Canonical markers are scanner-owned barriers, not completed
			// rollbacks. Their unresolved source stays blocked until the scanner
			// applies DB rollback state and settles the marker.
			.filter(
				(entry) => entry.canonicalRollbackAt == null && !entry.needsOperator && entry.nextRetryAt.getTime() <= now,
			)
			.sort(compareQuarantineChainPosition)
			.slice(0, MAX_PER_TICK);

		if (due.length === 0) {
			await reportQuarantineHealth();
			return;
		}

		logger.info('Reconciling quarantined transactions', { count: due.length });

		const blockedPaymentSourceIds = new Set<string>();
		for (const entry of due) {
			if (blockedPaymentSourceIds.has(entry.paymentSourceId)) continue;

			// Claim performs the earliest-unresolved check in the same serializable
			// transaction as its CAS, including predecessors in backoff/operator
			// states that the `due` query intentionally omitted.
			let claim: QuarantineClaim | null;
			try {
				claim = await claimQuarantinedTransaction(entry);
			} catch (error) {
				blockedPaymentSourceIds.add(entry.paymentSourceId);
				logger.error('Failed to claim quarantined transaction', {
					txHash: entry.txHash,
					error,
				});
				continue;
			}
			if (claim == null) {
				// Another instance claimed (or changed) the predecessor. Do not let
				// this instance skip ahead to its descendants.
				blockedPaymentSourceIds.add(entry.paymentSourceId);
				continue;
			}

			try {
				const outcome = await retryQuarantinedTransaction(entry, claim);
				logger.info('Quarantined transaction outcome', {
					txHash: entry.txHash,
					attempts: entry.attempts,
					outcome,
				});
				if (isBlockingQuarantineOutcome(outcome)) {
					blockedPaymentSourceIds.add(entry.paymentSourceId);
				}
			} catch (error) {
				// Release only our own claim. If the CAS fails, a newer owner already
				// controls the row and this worker must not overwrite it.
				await releaseQuarantineClaim(claim).catch((releaseError) => {
					logger.error('Failed to release quarantine processing lease', {
						txHash: entry.txHash,
						error: releaseError instanceof Error ? releaseError.message : String(releaseError),
					});
				});
				blockedPaymentSourceIds.add(entry.paymentSourceId);
				logger.error('Failed to reconcile quarantined transaction', {
					txHash: entry.txHash,
					error,
				});
			}
		}

		await reportQuarantineHealth();
	});
}

type QuarantineEntry = Prisma.TxSyncQuarantineGetPayload<{
	include: { PaymentSource: { include: { PaymentSourceConfig: true } } };
}>;

async function retryQuarantinedTransaction(entry: QuarantineEntry, claim: QuarantineClaim): Promise<QuarantineOutcome> {
	const paymentContract = entry.PaymentSource;
	const blockfrost = createApiClient(paymentContract.network, paymentContract.PaymentSourceConfig.rpcProviderApiKey);

	const { txData, failures } = await getExtendedTxInformation(
		[
			{
				tx_hash: entry.txHash,
				block_time: 0,
				block_height: entry.blockHeight ?? 0,
				tx_index: entry.txIndex ?? 0,
			},
		],
		blockfrost,
		1,
	);

	if (failures.length > 0) {
		return await handleRetryFailure(entry, claim, failures[0].error);
	}
	if (txData.length === 0) {
		return await handleRetryFailure(
			entry,
			claim,
			new Error('Extended lookup returned neither transaction data nor a failure'),
		);
	}

	// The scanner refuses to process below BLOCK_CONFIRMATIONS_THRESHOLD — that
	// is its rollback protection, and applying a still-shallow tx here would
	// bypass it (a tx quarantined moments after landing can be retried within
	// 30s, well before it is deep enough). Defer WITHOUT burning an attempt:
	// waiting for confirmations is not a failure, and counting it as one would
	// walk healthy entries toward needsOperator.
	if (txData[0].block.confirmations < CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD) {
		await deferClaimedQuarantine(claim, new Date(Date.now() + CONFIRMATION_WAIT_MS));
		return 'retry';
	}

	try {
		await processTransactionData(txData[0], paymentContract, blockfrost, {
			beforeWrite: async (txdb) => await fenceQuarantineClaimWrite(txdb, claim),
		});
	} catch (error) {
		if (isQuarantineLeaseLostError(error)) throw error;
		return await handleRetryFailure(entry, claim, error);
	}

	await resolveQuarantinedTransaction(claim);
	return 'resolved';
}

async function handleRetryFailure(
	entry: QuarantineEntry,
	claim: QuarantineClaim,
	error: unknown,
): Promise<QuarantineOutcome> {
	if (isQuarantineLeaseLostError(error)) throw error;
	const classification = classifyQuarantineError(error);

	if (classification === 'terminal') {
		await markClaimedQuarantineNeedsOperator(claim, error);
		logger.error('Quarantined transaction failed with a non-retryable error; operator attention required', {
			txHash: entry.txHash,
			error,
		});
		return 'terminal';
	}

	await recordQuarantineAttempt({
		claim,
		attempts: entry.attempts,
		error,
	});
	return 'retry';
}

async function reportQuarantineHealth(): Promise<void> {
	const health = await getQuarantineHealth();
	if (health.pending === 0) return;

	const ageMinutes = health.oldestPendingAgeMs == null ? 0 : Math.round(health.oldestPendingAgeMs / 60000);

	// Depth alone understates the problem — a queue of one that has been stuck
	// for hours is worse than a queue of fifty draining normally.
	const level = health.needsOperator > 0 || ageMinutes >= 10 ? 'error' : 'info';
	logger[level]('tx-sync quarantine status', {
		pending: health.pending,
		needsOperator: health.needsOperator,
		oldestPendingAgeMinutes: ageMinutes,
	});
}
