import type { Network, Prisma } from '@/generated/prisma/client';
import { HydraTopupStatus } from '@/generated/prisma/client';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { isUniqueConstraintError } from '@masumi/payment-core/db-retry';
import { CONFIG } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { releaseHotWalletAfterL1 } from '@/utils/db/hot-wallet-lock';

/**
 * Wait beyond invalid-hereafter before declaring an absent deposit impossible.
 * Mirrors the initial-commit reconciliation: the extra slots cover a short
 * rollback and Blockfrost indexing lag without permitting a double top-up.
 */
export const HYDRA_TOPUP_SLOT_GRACE = 60n;

const MAX_TOPUPS_PER_TICK = 50;

export type HydraTopupReservation = {
	/** The row created when the request was accepted, now bound to a real deposit. */
	topupId: string;
	hydraHeadId: string;
	hydraLocalParticipantId: string;
	depositTxHash: string;
	invalidHereafterSlot: bigint;
	committedLovelace: bigint;
	committedAssets: Prisma.InputJsonValue;
};

export type PendingHydraTopupCandidate = {
	id: string;
	status: HydraTopupStatus;
	depositTxHash: string;
	invalidHereafterSlot: bigint;
	network: Network;
	rpcProviderApiKey: string;
};

export type HydraTopupReconciliationResult =
	| 'confirmed'
	| 'failed'
	| 'pending'
	| 'transient-error'
	| 'malformed'
	| 'raced';

export class HydraTopupReservationConflictError extends Error {
	constructor() {
		super('Another Hydra top-up is already pending reconciliation for this participant');
		this.name = 'HydraTopupReservationConflictError';
	}
}

/**
 * Persist the pending deposit identity before any ambiguous submission I/O, then
 * submit. The partial unique index guarantees at most one Pending top-up per
 * participant, so a concurrent reservation fails closed. As with the initial
 * commit there is deliberately no cleanup on submit failure: a throw or explicit
 * node rejection cannot prove the deposit was not relayed, so reconciliation
 * owns every later mutation.
 */
export async function reserveAndSubmitHydraTopup<T>(
	reservation: HydraTopupReservation,
	submit: () => Promise<T>,
): Promise<{ topupId: string; submitResult: T }> {
	let topupId: string;
	try {
		// The row already exists: it was created when the operator asked, so the
		// work would be visible while the pre-split confirmed. What happens here is
		// the promotion that binds it to a real deposit. The reservation work is done
		// by `HydraTopup_one_pending_per_participant_key`, the partial unique index
		// on `hydraLocalParticipantId WHERE status = 'Pending'` — not by anything on
		// the hash, which has no unique constraint.
		const promoted = await prisma.hydraTopup.update({
			where: { id: reservation.topupId },
			data: {
				depositTxHash: reservation.depositTxHash,
				invalidHereafterSlot: reservation.invalidHereafterSlot,
				committedLovelace: reservation.committedLovelace,
				committedAssets: reservation.committedAssets,
				status: HydraTopupStatus.Pending,
			},
			select: { id: true },
		});
		topupId = promoted.id;
	} catch (error) {
		if (isUniqueConstraintError(error)) throw new HydraTopupReservationConflictError();
		throw error;
	}

	const submitResult = await submit();
	return { topupId, submitResult };
}

/**
 * Resolve one pending top-up deposit against an independent L1 source. The Hydra
 * node's submit response is not evidence of inclusion, so a top-up is promoted
 * to Confirmed only when Blockfrost sees the exact deposit hash, and marked
 * Failed (retry-safe) only once a trusted current slot is beyond the signed TTL
 * plus grace with the hash absent. Every mutation binds the exact hash to keep
 * concurrent scheduler/API reconciliation idempotent.
 *
 * Deliberately NOT driven by the node's `CommitRecorded` / `DepositRecorded`
 * event, which looks like it would make this redundant. Three reasons it cannot:
 *
 *  - Liveness. The node's Blockfrost chain follower sleeps a full block time
 *    before every block and only runs its delay-free catch-up at startup, so it
 *    is structurally slower than the chain and does not recover lost ground
 *    without a restart. Confirmation would inherit that.
 *  - Absence is not observable. Marking a deposit Failed requires proving the
 *    hash is not on chain past TTL plus grace. No event stream can carry that;
 *    it needs a trusted current slot from an independent source.
 *  - Depth. Promotion waits for BLOCK_CONFIRMATIONS_THRESHOLD, which the frame
 *    does not report.
 *
 * The node is authoritative for exactly one thing here, and we do take it from
 * the event: the deadline in the deposit datum, which is derived from the
 * drafting node's chain time and cannot be reconstructed from the deposit
 * transaction. See the DepositRecorded handler in hydra-connection-manager.
 */
export async function reconcilePendingHydraTopup(
	candidate: PendingHydraTopupCandidate,
): Promise<HydraTopupReconciliationResult> {
	if (candidate.status === HydraTopupStatus.Confirmed) return 'confirmed';
	if (candidate.status === HydraTopupStatus.Failed) return 'failed';

	const { id, depositTxHash, invalidHereafterSlot } = candidate;
	if (!/^[0-9a-f]{64}$/.test(depositTxHash) || invalidHereafterSlot < 0n) return 'malformed';

	const chainResult = await lookupConfirmedChainTx({
		network: candidate.network,
		rpcProviderApiKey: candidate.rpcProviderApiKey,
		txHash: depositTxHash,
		requiredConfirmations: CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD,
	});

	if (chainResult === 'confirmed-valid') {
		const promoted = await prisma.hydraTopup.updateMany({
			where: { id, status: HydraTopupStatus.Pending },
			data: { status: HydraTopupStatus.Confirmed },
		});
		return promoted.count === 1 ? 'confirmed' : 'raced';
	}
	if (chainResult === 'confirmed-invalid') return await failPendingTopup(id);
	if (chainResult === 'pending') return 'pending';
	if (chainResult === 'transient-error') return 'transient-error';

	const currentSlot = await fetchTrustedCurrentSlot(candidate.network, candidate.rpcProviderApiKey);
	if (currentSlot == null) return 'transient-error';
	if (currentSlot <= invalidHereafterSlot + HYDRA_TOPUP_SLOT_GRACE) return 'pending';

	return await failPendingTopup(id);
}

async function failPendingTopup(id: string): Promise<'failed' | 'raced'> {
	const failed = await prisma.hydraTopup.updateMany({
		where: { id, status: HydraTopupStatus.Pending },
		data: { status: HydraTopupStatus.Failed },
	});
	return failed.count === 1 ? 'failed' : 'raced';
}

/** Reconcile pending top-up deposits even if the initiating API request died. */
export async function reconcilePendingHydraTopups(): Promise<void> {
	const candidates = await prisma.hydraTopup.findMany({
		where: { status: HydraTopupStatus.Pending },
		include: {
			LocalParticipant: {
				include: {
					Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } },
				},
			},
		},
		orderBy: { updatedAt: 'asc' },
		take: MAX_TOPUPS_PER_TICK,
	});

	await Promise.allSettled(
		candidates.map(async (candidate) => {
			const rpcProviderApiKey = candidate.LocalParticipant.Wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (!rpcProviderApiKey) {
				logger.error('hydra-topup-reconciliation: pending top-up is missing trusted L1 lookup context', {
					topupId: candidate.id,
				});
				return;
			}
			// A Preparing row has no deposit to look for yet: it is waiting on its
			// own pre-split, and the API request that owns it will promote it.
			if (candidate.depositTxHash === null || candidate.invalidHereafterSlot === null) {
				return;
			}
			try {
				const result = await reconcilePendingHydraTopup({
					id: candidate.id,
					status: candidate.status,
					depositTxHash: candidate.depositTxHash,
					invalidHereafterSlot: candidate.invalidHereafterSlot,
					network: candidate.LocalParticipant.Wallet.PaymentSource.network,
					rpcProviderApiKey,
				});
				if (result === 'confirmed' || result === 'failed') {
					logger.info(`hydra-topup-reconciliation: top-up ${result}`, {
						topupId: candidate.id,
						depositTxHash: candidate.depositTxHash,
					});
					// Not for the row the commit handler writes alongside its own
					// reservation so the deposit shows up in the list. That row names the
					// SAME L1 transaction as `LocalParticipant.commitTxHash`, and the
					// commit reconciler already releases on it — so both jobs released,
					// on their own schedules, for one deposit.
					//
					// The second release is the dangerous one. `releaseHotWalletAfterL1`
					// is fenced on `lockPurpose` alone, which is a shared constant rather
					// than an operation's identity, so once this row has resolved and a
					// later Hydra top-up has claimed the same wallet, the commit job's
					// release frees THAT operation's lock while its carve is still
					// unconfirmed — and a batcher then builds over the carve's inputs.
					//
					// One deposit, one releaser: the commit reservation owns this lock.
					// Read off the row. Deriving it from `LocalParticipant.commitTxHash` meant
					// the guard stopped holding the moment a cleared commit was retried under a
					// new hash — and it is exactly then, resolving the abandoned commit's row,
					// that this would free the retry's lock.
					const isCommitDisplayRow = candidate.isInitialCommit;
					if (!isCommitDisplayRow) {
						// The top-up holds this wallet from its claim until the deposit it
						// submitted stops being outstanding, which is here. Releasing when
						// the request returned handed the wallet to a batcher that could
						// still see the deposit's inputs as unspent.
						await releaseHotWalletAfterL1(candidate.LocalParticipant.walletId);
					}
				}
			} catch (error) {
				logger.error('hydra-topup-reconciliation: candidate failed', {
					topupId: candidate.id,
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
