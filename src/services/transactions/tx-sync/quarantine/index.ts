import { TxSyncQuarantineReason } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

/**
 * Backoff schedule for retrying a quarantined transaction, indexed by attempt
 * count. Front-loaded because the overwhelming majority of quarantines are
 * transient Blockfrost failures that clear within seconds; the long tail exists
 * so a genuinely stuck transaction stops generating load.
 */
const RETRY_BACKOFF_MS = [
	30 * 1000, // 30s
	2 * 60 * 1000, // 2m
	10 * 60 * 1000, // 10m
	30 * 60 * 1000, // 30m
	60 * 60 * 1000, // 1h
];

/** Attempts beyond this stop being retried and are flagged for an operator. */
export const MAX_QUARANTINE_ATTEMPTS = 12;

export function nextRetryDelayMs(attempts: number): number {
	const index = Math.min(Math.max(attempts, 0), RETRY_BACKOFF_MS.length - 1);
	return RETRY_BACKOFF_MS[index];
}

export function errorToText(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	if (typeof error === 'string') return error;
	try {
		// JSON.stringify returns the VALUE undefined (not a string) for undefined,
		// functions and symbols — callers do .toLowerCase()/.slice() on this, so
		// returning it unguarded throws at the point of use.
		return JSON.stringify(error) ?? String(error);
	} catch {
		// Circular structures land here.
		return String(error);
	}
}

/**
 * Records a transaction the scanner could not fetch or process.
 *
 * Idempotent per (paymentSourceId, txHash): re-quarantining an already-known
 * transaction refreshes the diagnosis rather than duplicating, so the scanner
 * re-encountering the same tx is harmless.
 *
 * Deliberately does NOT swallow its own failures. If the quarantine cannot be
 * recorded, the caller must not advance its checkpoint — that is the one case
 * where halting is genuinely correct, because the alternative is exactly the
 * silent loss this table exists to prevent.
 */
export async function quarantineTransaction(params: {
	paymentSourceId: string;
	txHash: string;
	blockHeight: number | null;
	txIndex: number | null;
	reason: TxSyncQuarantineReason;
	error: unknown;
	nowMs?: number;
}): Promise<void> {
	const now = params.nowMs ?? Date.now();
	const lastError = errorToText(params.error).slice(0, 2000);

	await prisma.txSyncQuarantine.upsert({
		where: {
			paymentSourceId_txHash: { paymentSourceId: params.paymentSourceId, txHash: params.txHash },
		},
		create: {
			paymentSourceId: params.paymentSourceId,
			txHash: params.txHash,
			blockHeight: params.blockHeight,
			txIndex: params.txIndex,
			reason: params.reason,
			lastError,
			nextRetryAt: new Date(now + nextRetryDelayMs(0)),
		},
		update: {
			// Re-observing a quarantined tx means the scanner passed it again. Keep
			// the attempt count (the reconciler owns that) but refresh the diagnosis
			// and un-resolve it, since it is evidently still outstanding.
			reason: params.reason,
			lastError,
			resolvedAt: null,
		},
	});

	logger.error('Quarantined transaction; sync checkpoint may advance past it', {
		paymentSourceId: params.paymentSourceId,
		txHash: params.txHash,
		blockHeight: params.blockHeight,
		txIndex: params.txIndex,
		reason: params.reason,
		lastError,
	});
}

/** Marks a quarantined tx as dealt with. Rows are kept for audit. */
export async function resolveQuarantinedTransaction(id: string, nowMs: number = Date.now()): Promise<void> {
	await prisma.txSyncQuarantine.update({
		where: { id },
		data: { resolvedAt: new Date(nowMs), needsOperator: false },
	});
}

/** Records a failed retry and schedules the next one, escalating when exhausted. */
export async function recordQuarantineAttempt(params: {
	id: string;
	attempts: number;
	error: unknown;
	nowMs?: number;
}): Promise<void> {
	const now = params.nowMs ?? Date.now();
	const attempts = params.attempts + 1;
	const exhausted = attempts >= MAX_QUARANTINE_ATTEMPTS;

	await prisma.txSyncQuarantine.update({
		where: { id: params.id },
		data: {
			attempts,
			lastError: errorToText(params.error).slice(0, 2000),
			nextRetryAt: new Date(now + nextRetryDelayMs(attempts)),
			needsOperator: exhausted,
		},
	});
}

/**
 * Terminal, non-error outcome: the transaction is no longer on chain, so there
 * is nothing left to apply. A rolled-back tx is the expected case.
 */
export async function discardQuarantinedTransaction(
	id: string,
	why: string,
	nowMs: number = Date.now(),
): Promise<void> {
	await prisma.txSyncQuarantine.update({
		where: { id },
		data: { resolvedAt: new Date(nowMs), needsOperator: false, lastError: why },
	});
}

export type QuarantineHealth = {
	pending: number;
	needsOperator: number;
	oldestPendingAgeMs: number | null;
};

/**
 * Queue depth and age, for alerting. The incident this table was built for went
 * unnoticed for four hours because the only signal was a log line nothing
 * watched. Depth alone is not enough — age is what distinguishes "briefly
 * retrying" from "stuck".
 */
export async function getQuarantineHealth(nowMs: number = Date.now()): Promise<QuarantineHealth> {
	const [pending, needsOperator, oldest] = await Promise.all([
		prisma.txSyncQuarantine.count({ where: { resolvedAt: null } }),
		prisma.txSyncQuarantine.count({ where: { resolvedAt: null, needsOperator: true } }),
		prisma.txSyncQuarantine.findFirst({
			where: { resolvedAt: null },
			orderBy: { createdAt: 'asc' },
			select: { createdAt: true },
		}),
	]);

	return {
		pending,
		needsOperator,
		oldestPendingAgeMs: oldest == null ? null : nowMs - oldest.createdAt.getTime(),
	};
}
