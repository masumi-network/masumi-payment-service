import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { createApiClient, withJobLock } from '@/services/shared';
import { CONFIG } from '@masumi/payment-core/config';
import { Mutex } from 'async-mutex';
import { getExtendedTxInformation } from '../blockchain';
import {
	discardQuarantinedTransaction,
	errorToText,
	getQuarantineHealth,
	recordQuarantineAttempt,
	resolveQuarantinedTransaction,
} from './index';
import { processTransactionData } from '../service';

/** How many quarantined transactions one tick will attempt. */
const MAX_PER_TICK = 25;

/** Re-check cadence while waiting for a shallow tx to reach the threshold. */
const CONFIRMATION_WAIT_MS = 60 * 1000;

/**
 * A quarantined transaction is retried until it succeeds, is found to no longer
 * exist on chain, or is classified terminal. Deciding which is which is the
 * whole job — "retry forever" and "give up immediately" are both wrong.
 */
export type QuarantineOutcome = 'resolved' | 'discarded' | 'retry' | 'terminal';

/**
 * Classifies a failure into what should happen next.
 *
 * The hard case is 404. Blockfrost returns it both for a transaction it has not
 * indexed yet (transient — retry) and for one that no longer exists because the
 * chain rolled back (terminal — there is nothing left to apply). They are
 * indistinguishable from the error alone, so the caller disambiguates by asking
 * whether the transaction is still on chain; this function only decides when
 * that question needs asking.
 */
export function classifyQuarantineError(error: unknown): 'not-found' | 'transient' | 'terminal' {
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
		const due = await prisma.txSyncQuarantine.findMany({
			where: {
				resolvedAt: null,
				needsOperator: false,
				nextRetryAt: { lte: new Date() },
				// Soft-deleted payment sources keep their rows (the FK cascade only
				// fires on hard delete); without this filter their entries would
				// cycle through the backoff ladder forever.
				PaymentSource: { deletedAt: null },
			},
			orderBy: [{ blockHeight: 'asc' }, { txIndex: 'asc' }, { createdAt: 'asc' }],
			take: MAX_PER_TICK,
			include: {
				PaymentSource: { include: { PaymentSourceConfig: true } },
			},
		});

		if (due.length === 0) {
			await reportQuarantineHealth();
			return;
		}

		logger.info('Reconciling quarantined transactions', { count: due.length });

		for (const entry of due) {
			try {
				const outcome = await retryQuarantinedTransaction(entry);
				logger.info('Quarantined transaction outcome', {
					txHash: entry.txHash,
					attempts: entry.attempts,
					outcome,
				});
			} catch (error) {
				// The retry machinery itself failed (DB down, etc). Leave the row
				// untouched so it is picked up again rather than losing its place.
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

async function retryQuarantinedTransaction(entry: QuarantineEntry): Promise<QuarantineOutcome> {
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
		return await handleRetryFailure(entry, failures[0].error, blockfrost);
	}

	// The scanner refuses to process below BLOCK_CONFIRMATIONS_THRESHOLD — that
	// is its rollback protection, and applying a still-shallow tx here would
	// bypass it (a tx quarantined moments after landing can be retried within
	// 30s, well before it is deep enough). Defer WITHOUT burning an attempt:
	// waiting for confirmations is not a failure, and counting it as one would
	// walk healthy entries toward needsOperator.
	if (txData[0].block.confirmations < CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD) {
		await prisma.txSyncQuarantine.update({
			where: { id: entry.id },
			data: { nextRetryAt: new Date(Date.now() + CONFIRMATION_WAIT_MS) },
		});
		return 'retry';
	}

	try {
		await processTransactionData(txData[0], paymentContract, blockfrost);
	} catch (error) {
		return await handleRetryFailure(entry, error, blockfrost);
	}

	await resolveQuarantinedTransaction(entry.id);
	return 'resolved';
}

async function handleRetryFailure(
	entry: QuarantineEntry,
	error: unknown,
	blockfrost: ReturnType<typeof createApiClient>,
): Promise<QuarantineOutcome> {
	const classification = classifyQuarantineError(error);

	if (classification === 'not-found') {
		// Disambiguate "not indexed yet" from "rolled back" by asking the chain
		// directly. If the transaction genuinely no longer exists there is nothing
		// to apply and retrying forever would be a slow leak.
		const stillOnChain = await isTransactionOnChain(blockfrost, entry.txHash);
		if (!stillOnChain) {
			await discardQuarantinedTransaction(
				entry.id,
				'Transaction is no longer on chain (rolled back); nothing to apply',
			);
			return 'discarded';
		}
	}

	if (classification === 'terminal') {
		await prisma.txSyncQuarantine.update({
			where: { id: entry.id },
			data: { needsOperator: true, lastError: errorToText(error).slice(0, 2000) },
		});
		logger.error('Quarantined transaction failed with a non-retryable error; operator attention required', {
			txHash: entry.txHash,
			error,
		});
		return 'terminal';
	}

	await recordQuarantineAttempt({ id: entry.id, attempts: entry.attempts, error });
	return 'retry';
}

async function isTransactionOnChain(blockfrost: ReturnType<typeof createApiClient>, txHash: string): Promise<boolean> {
	try {
		await blockfrost.txs(txHash);
		return true;
	} catch (error) {
		// Only a definitive 404 proves absence. Anything else (rate limit, 5xx) is
		// inconclusive, and we must not discard a transaction on inconclusive
		// evidence — assume it is still there and retry later.
		return classifyQuarantineError(error) !== 'not-found';
	}
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
