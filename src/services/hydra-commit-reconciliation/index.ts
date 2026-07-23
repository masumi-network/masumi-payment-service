import type { Network } from '@/generated/prisma/client';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { CONFIG } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

/**
 * Wait beyond invalid-hereafter before declaring an absent commit impossible.
 * This mirrors ambiguous L1 funding reconciliation: the extra slots cover a
 * short rollback and Blockfrost indexing lag without permitting a double send.
 */
export const HYDRA_COMMIT_SLOT_GRACE = 60n;

const MAX_COMMITS_PER_TICK = 50;

export type PendingHydraCommitCandidate = {
	id: string;
	hasCommitted: boolean;
	commitTxHash: string | null;
	commitInvalidHereafterSlot: bigint | null;
	network: Network;
	rpcProviderApiKey: string;
};

export type HydraCommitReconciliationResult =
	| 'none'
	| 'pending'
	| 'confirmed'
	| 'cleared'
	| 'transient-error'
	| 'malformed'
	| 'raced';

export class HydraCommitReservationConflictError extends Error {
	constructor() {
		super('Another Hydra commit submission is already pending reconciliation');
		this.name = 'HydraCommitReservationConflictError';
	}
}

/** Persist the exact signed body identity before any potentially ambiguous I/O. */
export async function reserveAndSubmitHydraCommit<T>(
	reservation: { participantId: string; commitTxHash: string; invalidHereafterSlot: bigint },
	submit: () => Promise<T>,
): Promise<T> {
	const reserved = await prisma.hydraLocalParticipant.updateMany({
		where: {
			id: reservation.participantId,
			hasCommitted: false,
			commitTxHash: null,
			commitInvalidHereafterSlot: null,
		},
		data: {
			commitTxHash: reservation.commitTxHash,
			commitInvalidHereafterSlot: reservation.invalidHereafterSlot,
		},
	});
	if (reserved.count !== 1) throw new HydraCommitReservationConflictError();

	// Deliberately no catch/cleanup: a throw or explicit node rejection cannot
	// prove the body was not relayed. Reconciliation owns every later mutation.
	return await submit();
}

/**
 * Resolve one exact pending commit against an independent L1 source.
 *
 * The Hydra node's submit response is not evidence of inclusion. We promote
 * only when Blockfrost sees the exact signed body hash. Conversely, absence is
 * not enough to retry until a trusted current slot is beyond the signed TTL and
 * grace window. Every mutation binds the exact hash + TTL to make concurrent
 * scheduler/API reconciliation idempotent.
 */
export async function reconcilePendingHydraCommit(
	candidate: PendingHydraCommitCandidate,
): Promise<HydraCommitReconciliationResult> {
	if (candidate.hasCommitted) return 'confirmed';

	const { commitTxHash, commitInvalidHereafterSlot } = candidate;
	if (commitTxHash == null && commitInvalidHereafterSlot == null) return 'none';
	if (
		commitTxHash == null ||
		commitInvalidHereafterSlot == null ||
		!/^[0-9a-f]{64}$/.test(commitTxHash) ||
		commitInvalidHereafterSlot < 0n
	) {
		return 'malformed';
	}

	const chainResult = await lookupConfirmedChainTx({
		network: candidate.network,
		rpcProviderApiKey: candidate.rpcProviderApiKey,
		txHash: commitTxHash,
		requiredConfirmations: CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD,
	});

	if (chainResult === 'confirmed-valid') {
		const promoted = await prisma.hydraLocalParticipant.updateMany({
			where: {
				id: candidate.id,
				hasCommitted: false,
				commitTxHash,
				commitInvalidHereafterSlot,
			},
			data: { hasCommitted: true },
		});
		return promoted.count === 1 ? 'confirmed' : 'raced';
	}

	if (chainResult === 'confirmed-invalid') {
		return await clearExactHydraCommitReservation(candidate.id, commitTxHash, commitInvalidHereafterSlot);
	}
	if (chainResult === 'pending') return 'pending';
	if (chainResult === 'transient-error') return 'transient-error';

	const currentSlot = await fetchTrustedCurrentSlot(candidate.network, candidate.rpcProviderApiKey);
	if (currentSlot == null) return 'transient-error';
	if (currentSlot <= commitInvalidHereafterSlot + HYDRA_COMMIT_SLOT_GRACE) return 'pending';

	return await clearExactHydraCommitReservation(candidate.id, commitTxHash, commitInvalidHereafterSlot);
}

async function clearExactHydraCommitReservation(
	participantId: string,
	commitTxHash: string,
	commitInvalidHereafterSlot: bigint,
): Promise<'cleared' | 'raced'> {
	const cleared = await prisma.hydraLocalParticipant.updateMany({
		where: {
			id: participantId,
			hasCommitted: false,
			commitTxHash,
			commitInvalidHereafterSlot,
		},
		data: {
			commitTxHash: null,
			commitInvalidHereafterSlot: null,
		},
	});
	return cleared.count === 1 ? 'cleared' : 'raced';
}

/** Reconcile pending local-participant commits even if the initiating API died. */
export async function reconcilePendingHydraCommits(): Promise<void> {
	const candidates = await prisma.hydraLocalParticipant.findMany({
		where: {
			hasCommitted: false,
			commitTxHash: { not: null },
			commitInvalidHereafterSlot: { not: null },
		},
		include: {
			Wallet: {
				include: {
					PaymentSource: { include: { PaymentSourceConfig: true } },
				},
			},
		},
		orderBy: { updatedAt: 'asc' },
		take: MAX_COMMITS_PER_TICK,
	});

	await Promise.allSettled(
		candidates.map(async (candidate) => {
			const rpcProviderApiKey = candidate.Wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (!rpcProviderApiKey || !candidate.commitTxHash || candidate.commitInvalidHereafterSlot == null) {
				logger.error('hydra-commit-reconciliation: pending commit is missing trusted L1 lookup context', {
					participantId: candidate.id,
				});
				return;
			}

			try {
				const result = await reconcilePendingHydraCommit({
					id: candidate.id,
					hasCommitted: candidate.hasCommitted,
					commitTxHash: candidate.commitTxHash,
					commitInvalidHereafterSlot: candidate.commitInvalidHereafterSlot,
					network: candidate.Wallet.PaymentSource.network,
					rpcProviderApiKey,
				});
				if (result === 'confirmed' || result === 'cleared') {
					logger.info(`hydra-commit-reconciliation: commit ${result}`, {
						participantId: candidate.id,
						commitTxHash: candidate.commitTxHash,
					});
				}
			} catch (error) {
				logger.error('hydra-commit-reconciliation: candidate failed', {
					participantId: candidate.id,
					error: error instanceof Error ? error.message : 'Non-error failure',
				});
			}
		}),
	);
}

async function fetchTrustedCurrentSlot(network: Network, rpcProviderApiKey: string): Promise<bigint | null> {
	try {
		const latest = await getBlockfrostInstance(network, rpcProviderApiKey).blocksLatest();
		if (typeof latest.slot !== 'number' || !Number.isSafeInteger(latest.slot) || latest.slot < 0) return null;
		return BigInt(latest.slot);
	} catch {
		return null;
	}
}
