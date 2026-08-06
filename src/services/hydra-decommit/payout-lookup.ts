/**
 * Attaching the L1 transaction to a settled withdrawal.
 *
 * Everything the head knows is already recorded by the time this runs; this only
 * adds the one thing it cannot tell us. Kept apart from the settlement itself so
 * that a Blockfrost outage delays a link rather than a status.
 */

import { HydraDecommitStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { DecommitDistributedValue } from '@/lib/hydra';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { findDecommitPayoutTx } from './l1-payout';

/**
 * How long a settled withdrawal stays worth looking for.
 *
 * A decrement lands within a block or two, so anything still unidentified after
 * a day was not missed by timing and will not appear by waiting longer.
 */
const PAYOUT_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Kept small: each row costs several Blockfrost calls. */
const PAYOUT_LOOKUP_BATCH = 10;

/**
 * How often the retry pass runs.
 *
 * Deliberately not the shared Hydra interval. Each row costs up to
 * MAX_PAGES * PAGE_SIZE address-history lookups, so a full batch on a ten-second
 * schedule sustains roughly forty requests a second — several times a
 * Blockfrost free tier — to chase a link nobody is waiting on. A decrement lands
 * within a block or two, so five minutes loses nothing.
 */
export const PAYOUT_LOOKUP_INTERVAL_MS = 5 * 60 * 1000;

export async function resolveDecommitPayoutTx(params: {
	decommitId: string;
	distributed: DecommitDistributedValue;
}): Promise<void> {
	const { decommitId, distributed } = params;

	const row = await prisma.hydraDecommit.findUnique({
		where: { id: decommitId },
		include: {
			LocalParticipant: {
				include: { Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } } },
			},
		},
	});
	if (!row || row.l1TxId !== null) return;

	const paymentSource = row.LocalParticipant?.Wallet?.PaymentSource;
	const apiKey = paymentSource?.PaymentSourceConfig?.rpcProviderApiKey;
	if (!paymentSource || !apiKey) {
		logger.warn(`[HydraDecommit] no Blockfrost key available to identify the payout for ${decommitId}`);
		return;
	}

	const blockfrost = getBlockfrostInstance(paymentSource.network, apiKey);
	const txId = await findDecommitPayoutTx({
		blockfrost,
		address: row.destinationAddress,
		expected: distributed,
	});
	if (!txId) {
		logger.warn(`[HydraDecommit] could not identify the payout transaction for ${decommitId}`);
		return;
	}

	// Conditional, because the finalization path and the retry pass can both be
	// resolving the same row: the read above is not in a transaction with this
	// write, so the guard belongs here rather than only there.
	const { count } = await prisma.hydraDecommit.updateMany({
		where: { id: decommitId, l1TxId: null },
		data: { l1TxId: txId },
	});
	if (count > 0) logger.info(`[HydraDecommit] withdrawal ${decommitId} was paid out by ${txId}`);
}

/**
 * Retry the payout lookup for withdrawals that settled without one.
 *
 * Identification runs once at finalization and is deliberately allowed to fail:
 * a chain lookup must never be what decides whether a withdrawal counts as
 * settled. Without a second attempt, though, a single Blockfrost blip leaves the
 * row permanently unable to show where the money went, and there is nothing an
 * operator can do about it from the UI.
 *
 * Bounded by age rather than by attempt count: a payout that has not been
 * identified within a day is not going to be, and re-walking address history for
 * it forever would cost more than the link is worth.
 */
export async function reconcileUnidentifiedDecommitPayouts(): Promise<void> {
	const rows = await prisma.hydraDecommit.findMany({
		where: {
			status: HydraDecommitStatus.Finalized,
			l1TxId: null,
			settledLovelace: { not: null },
			finalizedAt: { gte: new Date(Date.now() - PAYOUT_LOOKUP_WINDOW_MS) },
		},
		select: { id: true, settledLovelace: true, settledAssets: true },
		// Oldest first. An unordered slice would hand back whichever rows the
		// planner happened to reach, so with more stuck rows than fit in a batch
		// the same few could be retried forever while the rest were never tried.
		orderBy: { finalizedAt: 'asc' },
		take: PAYOUT_LOOKUP_BATCH,
	});

	for (const row of rows) {
		if (row.settledLovelace === null) continue;
		try {
			await resolveDecommitPayoutTx({
				decommitId: row.id,
				distributed: {
					lovelace: row.settledLovelace,
					assets: (row.settledAssets as Record<string, string> | null) ?? {},
				},
			});
		} catch (error) {
			logger.warn(`[HydraDecommit] payout lookup retry failed for ${row.id}: ${String(error)}`);
		}
	}
}
