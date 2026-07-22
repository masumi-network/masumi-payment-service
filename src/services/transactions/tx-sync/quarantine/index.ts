import { Prisma, TxSyncQuarantineReason } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { createId } from '@paralleldrive/cuid2';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { CONFIG } from '@masumi/payment-core/config';
import { fencePaymentSourceTxSyncVersion, TxSyncFenceLostError } from './fenced-write';

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

/** Long enough for a normal reconciliation attempt, including provider retry. */
export const QUARANTINE_PROCESSING_LEASE_MS = 10 * 60 * 1000;

/**
 * One ordering definition for scanner/reconciler predecessor decisions.
 * Unknown legacy positions are conservative predecessors, never descendants.
 */
export const QUARANTINE_CHAIN_ORDER = [
	{ blockHeight: { sort: 'asc', nulls: 'first' } },
	{ txIndex: { sort: 'asc', nulls: 'first' } },
	{ createdAt: 'asc' },
	{ id: 'asc' },
] satisfies Prisma.TxSyncQuarantineOrderByWithRelationInput[];

type ChainPosition = {
	blockHeight: number | null;
	txIndex: number | null;
	createdAt: Date;
	id: string;
};

export function compareQuarantineChainPosition(left: ChainPosition, right: ChainPosition): number {
	if (left.blockHeight !== right.blockHeight) {
		if (left.blockHeight == null) return -1;
		if (right.blockHeight == null) return 1;
		return left.blockHeight - right.blockHeight;
	}
	if (left.txIndex !== right.txIndex) {
		if (left.txIndex == null) return -1;
		if (right.txIndex == null) return 1;
		return left.txIndex - right.txIndex;
	}
	const createdAtDifference = left.createdAt.getTime() - right.createdAt.getTime();
	if (createdAtDifference !== 0) return createdAtDifference;
	return left.id.localeCompare(right.id);
}

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
	expectedFenceVersion: number;
	nowMs?: number;
}): Promise<number> {
	const now = params.nowMs ?? Date.now();
	const lastError = errorToText(params.error).slice(0, 2000);

	const txSyncFenceVersion = await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (txdb) => {
					// Lock order is always PaymentSource -> quarantine row. Business
					// transactions take the same source lock first, so this increment is
					// the atomic epoch change that invalidates every older source claim.
					const source = await txdb.paymentSource.updateMany({
						where: {
							id: params.paymentSourceId,
							deletedAt: null,
							syncInProgress: true,
							txSyncFenceVersion: params.expectedFenceVersion,
						},
						data: { txSyncFenceVersion: { increment: 1 } },
					});
					if (source.count !== 1) throw new TxSyncFenceLostError(params.paymentSourceId);
					const nextFenceVersion = params.expectedFenceVersion + 1;
					const existing = await txdb.txSyncQuarantine.findUnique({
						where: {
							paymentSourceId_txHash: {
								paymentSourceId: params.paymentSourceId,
								txHash: params.txHash,
							},
						},
						select: { id: true, processingLeaseId: true, processingLeaseExpiresAt: true },
					});

					const hasLiveLease =
						existing?.processingLeaseId != null &&
						existing.processingLeaseExpiresAt != null &&
						existing.processingLeaseExpiresAt.getTime() > now;

					if (existing == null) {
						await txdb.txSyncQuarantine.create({
							data: {
								paymentSourceId: params.paymentSourceId,
								txHash: params.txHash,
								blockHeight: params.blockHeight,
								txIndex: params.txIndex,
								reason: params.reason,
								lastError,
								nextRetryAt: new Date(now + nextRetryDelayMs(0)),
							},
						});
						return nextFenceVersion;
					}

					await txdb.txSyncQuarantine.update({
						where: { id: existing.id },
						data: {
							// Keep attempts; the reconciler owns retry accounting.
							reason: params.reason,
							lastError,
							blockHeight: params.blockHeight,
							txIndex: params.txIndex,
							resolvedAt: null,
							// A rolled-back transaction can be re-included with the same hash.
							// Reopening its row must discard evidence from the old fork or the
							// reconciler would resolve it again without applying it.
							canonicalRollbackAt: null,
							// Preserve a live owner's token so it can release cleanly. The source
							// epoch bump above still makes all its writes/outcomes fail. Expired
							// tokens are stale and can be cleared immediately.
							...(hasLiveLease ? {} : { processingLeaseId: null, processingLeaseExpiresAt: null }),
						},
					});
					return nextFenceVersion;
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-quarantine-upsert' },
	);

	logger.error('Quarantined transaction; sync checkpoint may advance past it', {
		paymentSourceId: params.paymentSourceId,
		txHash: params.txHash,
		blockHeight: params.blockHeight,
		txIndex: params.txIndex,
		reason: params.reason,
		lastError,
	});

	return txSyncFenceVersion;
}

export type CanonicalRollbackMarker = {
	paymentSourceId: string;
	txHashes: string[];
	txSyncFenceVersion: number;
};

/**
 * Publishes canonical rollback evidence without calling it settled.
 *
 * The source epoch increment and row markers commit together. Existing workers
 * retain their lease token only so they can release it, but every write/outcome
 * they attempt with the older epoch is fenced out. Descendants remain blocked
 * behind the unresolved marker until scanner rollback writes have succeeded.
 */
export async function markCanonicalRolledBackQuarantines(params: {
	paymentSourceId: string;
	txHashes: string[];
	expectedFenceVersion: number;
	nowMs?: number;
}): Promise<CanonicalRollbackMarker> {
	if (params.txHashes.length === 0) {
		throw new Error('Cannot mark an empty canonical rollback set');
	}

	const canonicalRollbackAt = new Date(params.nowMs ?? Date.now());
	return await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (txdb) => {
					const source = await txdb.paymentSource.updateMany({
						where: {
							id: params.paymentSourceId,
							deletedAt: null,
							syncInProgress: true,
							txSyncFenceVersion: params.expectedFenceVersion,
						},
						data: { txSyncFenceVersion: { increment: 1 } },
					});
					if (source.count !== 1) throw new TxSyncFenceLostError(params.paymentSourceId);
					for (const txHash of params.txHashes) {
						await txdb.txSyncQuarantine.upsert({
							where: {
								paymentSourceId_txHash: { paymentSourceId: params.paymentSourceId, txHash },
							},
							create: {
								paymentSourceId: params.paymentSourceId,
								txHash,
								blockHeight: null,
								txIndex: null,
								reason: TxSyncQuarantineReason.CanonicalRollback,
								lastError: 'Canonical rollback detected; database rollback pending',
								nextRetryAt: canonicalRollbackAt,
								canonicalRollbackAt,
							},
							update: {
								blockHeight: null,
								txIndex: null,
								resolvedAt: null,
								needsOperator: false,
								reason: TxSyncQuarantineReason.CanonicalRollback,
								lastError: 'Canonical rollback detected; database rollback pending',
								canonicalRollbackAt,
							},
						});
					}

					return {
						paymentSourceId: params.paymentSourceId,
						txHashes: params.txHashes,
						txSyncFenceVersion: params.expectedFenceVersion + 1,
					};
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-canonical-rollback-mark' },
	);
}

/** Resolves canonical markers only after every rollback business write commits. */
export async function settleCanonicalRolledBackQuarantines(
	marker: CanonicalRollbackMarker,
	rollbackAnchor: string | null,
	nowMs: number = Date.now(),
): Promise<void> {
	const resolvedAt = new Date(nowMs);
	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (txdb) => {
					await fencePaymentSourceTxSyncVersion(txdb, marker.paymentSourceId, marker.txSyncFenceVersion);
					await txdb.txSyncQuarantine.updateMany({
						where: {
							paymentSourceId: marker.paymentSourceId,
							txHash: { in: marker.txHashes },
							resolvedAt: null,
							canonicalRollbackAt: { not: null },
						},
						data: {
							resolvedAt,
							needsOperator: false,
							lastError: 'Canonical address history confirms transaction rollback; database rollback applied',
							processingLeaseId: null,
							processingLeaseExpiresAt: null,
						},
					});
					// Marker settlement and cursor rewind are one commit. Exposing a
					// resolved marker while the orphan hash is still the cursor would let
					// a same-hash re-inclusion be sliced out as already processed.
					await txdb.paymentSource.update({
						where: { id: marker.paymentSourceId, deletedAt: null },
						data: { lastIdentifierChecked: rollbackAnchor },
					});
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-canonical-rollback-settle' },
	);
}

export type QuarantineClaim = {
	id: string;
	paymentSourceId: string;
	processingLeaseId: string;
	txSyncFenceVersion: number;
};

/**
 * Claims one due row with a database compare-and-set. The in-process mutex is
 * only an optimisation; this lease is what prevents two service instances from
 * applying the same row concurrently.
 */
export async function claimQuarantinedTransaction(
	entry: { id: string; paymentSourceId: string; updatedAt: Date },
	nowMs: number = Date.now(),
): Promise<QuarantineClaim | null> {
	return await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (txdb) => {
					const staleBefore = new Date(nowMs - CONFIG.SYNC_LOCK_TIMEOUT_INTERVAL);
					const acquiredSource = await txdb.paymentSource.updateMany({
						where: {
							id: entry.paymentSourceId,
							deletedAt: null,
							disableSyncAt: null,
							OR: [{ syncInProgress: false }, { syncInProgress: true, updatedAt: { lte: staleBefore } }],
						},
						data: { syncInProgress: true, txSyncFenceVersion: { increment: 1 } },
					});
					if (acquiredSource.count !== 1) return null;

					const source = await txdb.paymentSource.findUniqueOrThrow({
						where: { id: entry.paymentSourceId },
						select: { txSyncFenceVersion: true },
					});
					const releaseAcquiredSource = async () => {
						await txdb.paymentSource.updateMany({
							where: {
								id: entry.paymentSourceId,
								txSyncFenceVersion: source.txSyncFenceVersion,
								syncInProgress: true,
							},
							data: { syncInProgress: false },
						});
					};
					// The predecessor check and claim share one serializable snapshot. This
					// prevents two instances from independently claiming different rows for
					// one source when both become due together.
					const earliest = await txdb.txSyncQuarantine.findFirst({
						where: { paymentSourceId: entry.paymentSourceId, resolvedAt: null },
						orderBy: QUARANTINE_CHAIN_ORDER,
						select: { id: true },
					});
					if (earliest?.id !== entry.id) {
						await releaseAcquiredSource();
						return null;
					}

					const processingLeaseId = createId();
					const now = new Date(nowMs);
					const result = await txdb.txSyncQuarantine.updateMany({
						where: {
							id: entry.id,
							updatedAt: entry.updatedAt,
							resolvedAt: null,
							canonicalRollbackAt: null,
							AND: [
								{ OR: [{ processingLeaseId: null }, { processingLeaseExpiresAt: { lte: now } }] },
								{ needsOperator: false, nextRetryAt: { lte: now } },
							],
						},
						data: {
							processingLeaseId,
							processingLeaseExpiresAt: new Date(nowMs + QUARANTINE_PROCESSING_LEASE_MS),
						},
					});

					if (result.count !== 1) {
						await releaseAcquiredSource();
						return null;
					}

					return {
						id: entry.id,
						paymentSourceId: entry.paymentSourceId,
						processingLeaseId,
						txSyncFenceVersion: source.txSyncFenceVersion,
					};
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-quarantine-claim' },
	);
}

export class QuarantineLeaseLostError extends Error {
	constructor(id: string) {
		super(`Quarantine processing lease lost for ${id}`);
		this.name = 'QuarantineLeaseLostError';
	}
}

export function isQuarantineLeaseLostError(error: unknown): boolean {
	if (error instanceof QuarantineLeaseLostError) return true;
	if (error instanceof AggregateError) return error.errors.some(isQuarantineLeaseLostError);
	return false;
}

/**
 * First operation inside every reconciler business transaction. It locks the
 * source row, verifies the captured epoch, and renews the still-active row
 * lease through the caller's TransactionClient. Both locks remain held until
 * the surrounding business transaction commits.
 */
export async function fenceQuarantineClaimWrite(
	txdb: Prisma.TransactionClient,
	claim: QuarantineClaim,
	nowMs: number = Date.now(),
): Promise<void> {
	const now = new Date(nowMs);
	try {
		await fencePaymentSourceTxSyncVersion(txdb, claim.paymentSourceId, claim.txSyncFenceVersion);
	} catch (error) {
		if (error instanceof TxSyncFenceLostError) throw new QuarantineLeaseLostError(claim.id);
		throw error;
	}

	const result = await txdb.txSyncQuarantine.updateMany({
		where: {
			id: claim.id,
			paymentSourceId: claim.paymentSourceId,
			processingLeaseId: claim.processingLeaseId,
			processingLeaseExpiresAt: { gt: now },
			resolvedAt: null,
			canonicalRollbackAt: null,
		},
		data: { processingLeaseExpiresAt: new Date(nowMs + QUARANTINE_PROCESSING_LEASE_MS) },
	});

	if (result.count !== 1) {
		throw new QuarantineLeaseLostError(claim.id);
	}
}

async function updateClaimedQuarantine(
	claim: QuarantineClaim,
	data: Prisma.TxSyncQuarantineUpdateManyMutationInput,
	nowMs: number = Date.now(),
): Promise<void> {
	const now = new Date(nowMs);
	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (txdb) => {
					try {
						await fencePaymentSourceTxSyncVersion(txdb, claim.paymentSourceId, claim.txSyncFenceVersion);
					} catch (error) {
						if (error instanceof TxSyncFenceLostError) throw new QuarantineLeaseLostError(claim.id);
						throw error;
					}

					const result = await txdb.txSyncQuarantine.updateMany({
						where: {
							id: claim.id,
							paymentSourceId: claim.paymentSourceId,
							processingLeaseId: claim.processingLeaseId,
							processingLeaseExpiresAt: { gt: now },
							resolvedAt: null,
							canonicalRollbackAt: null,
						},
						data,
					});

					if (result.count !== 1) throw new QuarantineLeaseLostError(claim.id);

					const releasedSource = await txdb.paymentSource.updateMany({
						where: {
							id: claim.paymentSourceId,
							txSyncFenceVersion: claim.txSyncFenceVersion,
							syncInProgress: true,
						},
						data: { syncInProgress: false },
					});
					if (releasedSource.count !== 1) throw new QuarantineLeaseLostError(claim.id);
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-quarantine-outcome' },
	);
}

/** Releases a claim after worker-level infrastructure failure. */
export async function releaseQuarantineClaim(claim: QuarantineClaim): Promise<void> {
	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (txdb) => {
					// Best-effort ownership release. A scanner may already have bumped the
					// source version; in that case this CAS intentionally changes nothing.
					await txdb.paymentSource.updateMany({
						where: {
							id: claim.paymentSourceId,
							txSyncFenceVersion: claim.txSyncFenceVersion,
							syncInProgress: true,
						},
						data: { syncInProgress: false },
					});

					// The lease token is independently safe to clear: a successor has a
					// different token, while a scanner that preserved this stale token
					// should not have to wait ten minutes for it to expire.
					await txdb.txSyncQuarantine.updateMany({
						where: { id: claim.id, processingLeaseId: claim.processingLeaseId, resolvedAt: null },
						data: { processingLeaseId: null, processingLeaseExpiresAt: null },
					});
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-quarantine-release' },
	);
}

/** Confirmation waiting is not a failed attempt. */
export async function deferClaimedQuarantine(claim: QuarantineClaim, nextRetryAt: Date): Promise<void> {
	await updateClaimedQuarantine(claim, {
		nextRetryAt,
		processingLeaseId: null,
		processingLeaseExpiresAt: null,
	});
}

/** Stops retrying a deterministic failure until an operator re-queues it. */
export async function markClaimedQuarantineNeedsOperator(claim: QuarantineClaim, error: unknown): Promise<void> {
	await updateClaimedQuarantine(claim, {
		needsOperator: true,
		lastError: errorToText(error).slice(0, 2000),
		processingLeaseId: null,
		processingLeaseExpiresAt: null,
	});
}

/** Marks a claimed quarantined tx as dealt with. Rows are kept for audit. */
export async function resolveQuarantinedTransaction(claim: QuarantineClaim, nowMs: number = Date.now()): Promise<void> {
	await updateClaimedQuarantine(
		claim,
		{
			resolvedAt: new Date(nowMs),
			needsOperator: false,
			processingLeaseId: null,
			processingLeaseExpiresAt: null,
		},
		nowMs,
	);
}

/** Records a failed retry and schedules the next one, escalating when exhausted. */
export async function recordQuarantineAttempt(params: {
	claim: QuarantineClaim;
	attempts: number;
	error: unknown;
	nowMs?: number;
}): Promise<void> {
	const now = params.nowMs ?? Date.now();
	const attempts = params.attempts + 1;
	const exhausted = attempts >= MAX_QUARANTINE_ATTEMPTS;

	await updateClaimedQuarantine(
		params.claim,
		{
			attempts,
			lastError: errorToText(params.error).slice(0, 2000),
			nextRetryAt: new Date(now + nextRetryDelayMs(attempts)),
			needsOperator: exhausted,
			processingLeaseId: null,
			processingLeaseExpiresAt: null,
		},
		now,
	);
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
	const unresolvedActiveSourceWhere = {
		resolvedAt: null,
		PaymentSource: { deletedAt: null },
	} satisfies Prisma.TxSyncQuarantineWhereInput;

	const [pending, needsOperator, oldest] = await Promise.all([
		prisma.txSyncQuarantine.count({ where: unresolvedActiveSourceWhere }),
		prisma.txSyncQuarantine.count({ where: { ...unresolvedActiveSourceWhere, needsOperator: true } }),
		prisma.txSyncQuarantine.findFirst({
			where: unresolvedActiveSourceWhere,
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
