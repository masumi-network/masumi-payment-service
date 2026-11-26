// Deletes finished rows from tables that only grow, after a configurable number
// of days. Each table has its own *_RETENTION_DAYS env var; 0 keeps all history.
//
// Not covered, deliberately:
//   - HydraStoredSnapshot: replay rescans the whole head history on reconnect and
//     re-inserts missing snapshots, and the stored rows are the evidence that a
//     redelivered snapshot does not contradict signed state.
//   - Transaction: request history rows reference it.
//   - PaymentSourceIdentifiers: rollback detection walks back to the newest
//     stored identifier that is still on chain. A source that stops syncing
//     while a rollback happens could resume with none left and miss rollbacks.

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { CONFIG } from '@masumi/payment-core/config';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DATA_RETENTION_CLEANUP_INTERVAL_MS = DAY_MS;

/** Rows older than the returned date may go. null, 0 or below keeps all history. */
export function retentionCutoff(days: number | null, nowMs = Date.now()): Date | null {
	return days == null || !(days > 0 && Number.isFinite(days)) ? null : new Date(nowMs - days * DAY_MS);
}

export async function deleteRowsPastRetention(
	table: string,
	days: number | null,
	deleteOlderThan: (cutoff: Date) => Promise<{ count: number }>,
): Promise<void> {
	const cutoff = retentionCutoff(days);
	if (cutoff == null) return;
	try {
		const { count } = await deleteOlderThan(cutoff);
		if (count > 0) {
			logger.info('Deleted rows past retention', {
				table,
				deleted_count: count,
				cutoff_date: cutoff.toISOString(),
			});
		}
	} catch (error) {
		logger.error('Failed to delete rows past retention', {
			table,
			error: error instanceof Error ? error.message : 'Unknown error',
		});
	}
}

export async function cleanupRowsPastRetention(): Promise<void> {
	// Only resolved rows. Unresolved rows are ordering barriers for tx-sync.
	await deleteRowsPastRetention('TxSyncQuarantine', CONFIG.TX_SYNC_QUARANTINE_RETENTION_DAYS, (cutoff) =>
		prisma.txSyncQuarantine.deleteMany({ where: { resolvedAt: { lt: cutoff } } }),
	);
}
