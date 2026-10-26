/** Independent L1 payout proof and confirmation-depth reconciliation. */

import { HydraDecommitStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { CONFIG } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import type { DecommitDistributedValue } from '@/lib/hydra';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { decommitPayoutSearchBounds, findDecommitPayoutTx } from './l1-payout';

/** Match the conservative key-release depth even if the general threshold is lower. */
export const DECOMMIT_MIN_CONFIRMATIONS = 20;
/** Recheck recent finalized payouts for a rollback after initial promotion. */
const FINALITY_RECHECK_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Kept small: each row costs several Blockfrost calls. */
const PAYOUT_LOOKUP_BATCH = 10;

/**
 * How often the retry pass runs.
 *
 * Deliberately not the shared Hydra interval. Each row costs up to
 * several pages of address-history lookups back to its creation time. A short
 * schedule would repeatedly rescan busy wallets. The row remains Approved
 * during this retry interval; the node's event cannot grant spendability.
 */
export const PAYOUT_LOOKUP_INTERVAL_MS = 5 * 60 * 1000;

type Blockfrost = ReturnType<typeof getBlockfrostInstance>;

function isNotFound(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const value = error as { status_code?: unknown; statusCode?: unknown; status?: unknown };
	return value.status_code === 404 || value.statusCode === 404 || value.status === 404;
}

async function payoutDepth(observer: Blockfrost, txId: string): Promise<'deep' | 'shallow' | 'missing'> {
	let details: Awaited<ReturnType<Blockfrost['txs']>>;
	try {
		details = await observer.txs(txId);
	} catch (error) {
		if (isNotFound(error)) return 'missing';
		throw error;
	}
	if (details.hash.toLowerCase() !== txId.toLowerCase() || details.valid_contract !== true) return 'missing';
	let block: Awaited<ReturnType<Blockfrost['blocks']>>;
	try {
		block = await observer.blocks(details.block);
	} catch (error) {
		if (isNotFound(error)) return 'missing';
		throw error;
	}
	const confirmations = block.confirmations ?? 0;
	return Number.isSafeInteger(confirmations) &&
		confirmations >= Math.max(CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD, DECOMMIT_MIN_CONFIRMATIONS)
		? 'deep'
		: 'shallow';
}

export async function resolveDecommitPayoutTx(params: {
	decommitId: string;
	distributed: DecommitDistributedValue;
}): Promise<void> {
	const { decommitId, distributed } = params;

	const row = await prisma.hydraDecommit.findUnique({
		where: { id: decommitId },
		include: {
			HydraHead: { select: { headIdentifier: true } },
			LocalParticipant: {
				include: { Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } } },
			},
		},
	});
	if (!row || row.status !== HydraDecommitStatus.Approved || row.l1ObservedAt === null) return;
	if (row.HydraHead.headIdentifier === null) {
		logger.warn(`[HydraDecommit] no head identifier available to verify the payout for ${decommitId}`);
		return;
	}

	// Other withdrawals of the same head can pay the same address the same
	// amount minutes apart (Defect H); bound the search to this row's own
	// creation and rule out hashes already claimed by a sibling withdrawal.
	// The chain candidate must also move this head's state token and leave it Open.
	// See `decommitPayoutSearchBounds` for why the bound is createdAt and not
	// approvedAt.
	const siblingPayouts = await prisma.hydraDecommit.findMany({
		where: { hydraHeadId: row.hydraHeadId, id: { not: decommitId }, l1TxId: { not: null } },
		select: { l1TxId: true },
	});
	const { notBefore, exclude } = decommitPayoutSearchBounds(row, siblingPayouts);

	const paymentSource = row.LocalParticipant?.Wallet?.PaymentSource;
	const apiKey = paymentSource?.PaymentSourceConfig?.rpcProviderApiKey;
	if (!paymentSource || !apiKey) {
		logger.warn(`[HydraDecommit] no Blockfrost key available to identify the payout for ${decommitId}`);
		return;
	}

	const blockfrost = getBlockfrostInstance(paymentSource.network, apiKey);
	// Reprove provenance even for a hash written before this depth gate existed.
	// Older rows may have been linked by amount alone, so a cached hash cannot
	// grant Finalized after the migration.
	const txId = await findDecommitPayoutTx({
		blockfrost,
		headId: row.HydraHead.headIdentifier,
		address: row.destinationAddress,
		expected: distributed,
		notBefore,
		exclude,
	});
	if (!txId) {
		logger.warn(`[HydraDecommit] could not identify the payout transaction for ${decommitId}`);
		return;
	}

	// A replay can repair the observed amount while this proof is in flight.
	// Bind both writes to the value actually proved, including native assets.
	const provenValue = { settledLovelace: distributed.lovelace, settledAssets: { equals: distributed.assets } };
	const { count: linked } = await prisma.hydraDecommit.updateMany({
		where: {
			id: decommitId,
			status: HydraDecommitStatus.Approved,
			l1ObservedAt: { not: null },
			l1TxId: row.l1TxId,
			...provenValue,
		},
		data: { l1TxId: txId },
	});
	if (linked === 0) return;
	const depth = await payoutDepth(blockfrost, txId);
	if (depth === 'missing') {
		await prisma.hydraDecommit.updateMany({
			where: { id: decommitId, status: HydraDecommitStatus.Approved, l1TxId: txId },
			data: { l1TxId: null },
		});
		return;
	}
	if (depth !== 'deep') return;
	const { count } = await prisma.hydraDecommit.updateMany({
		where: {
			id: decommitId,
			status: HydraDecommitStatus.Approved,
			l1ObservedAt: { not: null },
			l1TxId: txId,
			...provenValue,
		},
		data: { status: HydraDecommitStatus.Finalized, finalizedAt: new Date(), l1CheckedAt: new Date() },
	});
	if (count > 0) logger.info(`[HydraDecommit] withdrawal ${decommitId} reached independent L1 depth in ${txId}`);
}

/**
 * Retry every observed but unproven payout, regardless of age. The Approved
 * status blocks another withdrawal and must never silently stop retrying.
 */
export async function reconcileUnidentifiedDecommitPayouts(): Promise<void> {
	const rows = await prisma.hydraDecommit.findMany({
		where: {
			status: HydraDecommitStatus.Approved,
			l1ObservedAt: { not: null },
			settledLovelace: { not: null },
		},
		select: { id: true, settledLovelace: true, settledAssets: true },
		// Oldest first. An unordered slice would hand back whichever rows the
		// planner happened to reach, so with more stuck rows than fit in a batch
		// the same few could be retried forever while the rest were never tried.
		orderBy: { l1CheckedAt: { sort: 'asc', nulls: 'first' } },
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
		} finally {
			await prisma.hydraDecommit.updateMany({
				where: { id: row.id, status: HydraDecommitStatus.Approved },
				data: { l1CheckedAt: new Date() },
			});
		}
	}
	const finalized = await prisma.hydraDecommit.findMany({
		where: {
			status: HydraDecommitStatus.Finalized,
			l1TxId: { not: null },
			finalizedAt: { gte: new Date(Date.now() - FINALITY_RECHECK_WINDOW_MS) },
		},
		select: {
			id: true,
			l1TxId: true,
			LocalParticipant: {
				select: {
					Wallet: {
						select: {
							PaymentSource: {
								select: { network: true, PaymentSourceConfig: { select: { rpcProviderApiKey: true } } },
							},
						},
					},
				},
			},
		},
		orderBy: { l1CheckedAt: { sort: 'asc', nulls: 'first' } },
		take: PAYOUT_LOOKUP_BATCH,
	});
	for (const row of finalized) {
		if (!row.l1TxId) continue;
		try {
			const paymentSource = row.LocalParticipant?.Wallet?.PaymentSource;
			const apiKey = paymentSource?.PaymentSourceConfig?.rpcProviderApiKey;
			if (!paymentSource || !apiKey) continue;
			if ((await payoutDepth(getBlockfrostInstance(paymentSource.network, apiKey), row.l1TxId)) === 'deep') continue;
			await prisma.hydraDecommit.updateMany({
				where: { id: row.id, status: HydraDecommitStatus.Finalized, l1TxId: row.l1TxId },
				data: { status: HydraDecommitStatus.Approved, finalizedAt: null, l1TxId: null, l1CheckedAt: new Date() },
			});
			logger.warn(
				`[HydraDecommit] payout ${row.l1TxId} lost required L1 depth; withdrawal ${row.id} is Approved again`,
			);
		} catch (error) {
			logger.warn(`[HydraDecommit] could not recheck payout ${row.l1TxId}: ${String(error)}`);
		} finally {
			// Failed reads and missing credentials must also yield their batch slot.
			await prisma.hydraDecommit.updateMany({
				where: { id: row.id, status: HydraDecommitStatus.Finalized, l1TxId: row.l1TxId },
				data: { l1CheckedAt: new Date() },
			});
		}
	}
}
