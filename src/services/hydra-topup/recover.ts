/**
 * Getting back a deposit the head never absorbed.
 *
 * A deposit does not sit in the wallet while it waits: the transaction locks the
 * funds at a deposit script, and the head claims them with an increment. If that
 * increment never happens, the funds do not come back on their own. They stay at
 * the script until someone asks the node to post a recover transaction, which it
 * will only do once the deposit's deadline has passed.
 *
 * That is not a rare corner. A hydra-node picks a deposit up only while it is
 * older than the deposit period and its deadline is more than one period away,
 * and it does not retry a snapshot request that goes unanswered (hydra#1999). A
 * short deposit period leaves a window narrow enough to miss, and every miss
 * strands real funds with no way to ask for them back.
 */

import createHttpError from 'http-errors';
import { HydraHeadStatus, HydraTopupStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { HYDRA_HEAD_STATUS_RANK } from '@/services/hydra-connection-manager/head-status-rank';
import { HydraTransportAmbiguousError, HydraTransportError } from '@/lib/hydra/hydra/errors';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import { fetchHydraAcknowledgedDeposits, type HydraAcknowledgedDeposit } from '@/lib/hydra/hydra/node-control-queries';
import { assertHydraHeadHostNotPaused, assertHydraHeadHostNotStopping } from '@/services/hydra-host/pause';

export type DepositRecovery = {
	/** Null while the top-up is still being prepared and has no deposit yet. */
	depositTxHash: string | null;
	/** True when the node was asked or the dispatch outcome is unknown. */
	requested: boolean;
	reason: string | null;
};

/**
 * Ask the node to return one deposit's funds.
 *
 * The node is the only party that can do this: the deposit script is spendable
 * by a recover transaction it builds, and only after the deadline written into
 * the deposit's own datum.
 */
export async function recoverHydraDeposit(topupId: string): Promise<DepositRecovery> {
	// `findUnique` and an explicit 404: the throwing variant raises a Prisma
	// P2025 that nothing on this path maps, so an id that does not exist came
	// back as a 500 while every neighbouring Hydra endpoint answered 404.
	const topup = await prisma.hydraTopup.findUnique({
		where: { id: topupId },
		select: {
			id: true,
			depositTxHash: true,
			status: true,
			hydraHeadId: true,
			nodeDeadline: true,
			HydraHead: { select: { status: true } },
		},
	});
	if (topup === null) {
		throw createHttpError(404, 'Hydra top-up not found');
	}

	if (topup.depositTxHash === null) {
		// Still being prepared: there is no deposit on chain to recover, and the
		// funds have not left the wallet.
		return {
			depositTxHash: null,
			requested: false,
			reason: 'this top-up is still being prepared, so nothing has been deposited yet',
		};
	}

	if (topup.status === HydraTopupStatus.Absorbed) {
		// The head has it. Recovery spends the deposit back out of the deposit
		// script, and the fold-in already spent it, so the node would refuse -
		// after the row had told an operator a recovery was on its way.
		return {
			depositTxHash: topup.depositTxHash,
			requested: false,
			reason: 'the head has already taken this deposit in, so there is nothing at the deposit script to return',
		};
	}

	if (topup.status === HydraTopupStatus.Pending) {
		// Still in flight. Recovering now would race the increment it is waiting
		// for, and the node would refuse anyway.
		return {
			depositTxHash: topup.depositTxHash,
			requested: false,
			reason: 'this deposit has not settled yet, so there is nothing to recover',
		};
	}

	// The node posts a new L1 transaction, which a paused Host must not do. The
	// deposit waits at its script, so recovering after Resume loses nothing.
	// Except a Confirmed one while the pause drains: the pause waits for it, and
	// a deposit the head never absorbs leaves Confirmed only through this
	// recovery, so refusing it would keep the pause draining forever.
	if (topup.status === HydraTopupStatus.Confirmed) {
		await assertHydraHeadHostNotStopping(topup.hydraHeadId);
	} else {
		await assertHydraHeadHostNotPaused(topup.hydraHeadId);
	}

	const manager = getHydraConnectionManager();
	const node = manager.getNode(topup.hydraHeadId);
	if (node === null) {
		throw createHttpError(
			502,
			'no live connection to this head’s node, so the recovery cannot be requested. Check the connection and try again',
		);
	}

	// A closed head confirms no more snapshots, and its fanout pays out only
	// what the head holds (hydra-node 2.4.1 `effectiveCommitDecommit` and the
	// head validator's fanout check), so a recovery cannot harm it. The status
	// comes from the node's own lifecycle frames, and a closed head never opens
	// again: a chain rollback changes only the node's chain state. A status that
	// lags the node only refuses a recovery that would have been safe.
	const isHeadClosed = HYDRA_HEAD_STATUS_RANK[topup.HydraHead.status] >= HYDRA_HEAD_STATUS_RANK[HydraHeadStatus.Closed];
	const refusal = isHeadClosed ? null : await refuseAcknowledgedDeposit(node, topup.depositTxHash, topup.nodeDeadline);
	if (refusal !== null) return refusal;

	try {
		await node.delete(`/commits/${topup.depositTxHash}`);
	} catch (error) {
		if (error instanceof HydraTransportError) {
			logger.warn(`hydra: recovery of deposit ${topup.depositTxHash} did not reach the node`);
			return {
				depositTxHash: topup.depositTxHash,
				requested: false,
				reason:
					'the Host could not connect to the node, so recovery was not requested. Check the connection and try again',
			};
		}
		// Building and submitting the recover transaction takes longer than the
		// HTTP client waits, so a lost response is the normal case rather than a
		// refusal. Keep the attempt timestamp to prevent a blind second request,
		// but do not claim that the node posted a transaction.
		if (error instanceof HydraTransportAmbiguousError) {
			logger.info(`hydra: recovery outcome for deposit ${topup.depositTxHash} is unknown; the node did not answer`);
			await markRecoveryRequested(topup.id);
			return {
				depositTxHash: topup.depositTxHash,
				requested: true,
				reason:
					'the node did not confirm the request. The recovery outcome is unknown; check the wallet and L1 before retrying',
			};
		}
		// A genuine refusal. Before the deadline this is what stops a recovery
		// racing an increment.
		const message = error instanceof Error ? error.message : 'the node refused the recovery';
		logger.warn(`hydra: recovery of deposit ${topup.depositTxHash} was refused: ${message}`);
		throw createHttpError(409, `the node would not recover this deposit yet: ${message}`);
	}

	logger.info(`hydra: requested recovery of deposit ${topup.depositTxHash} for head ${topup.hydraHeadId}`);
	await markRecoveryRequested(topup.id);
	return { depositTxHash: topup.depositTxHash, requested: true, reason: null };
}

/** How an operator frees a deposit that a signed snapshot still holds. */
const RELEASE_ACKNOWLEDGED_DEPOSIT =
	'Recovering it while that snapshot holds it can stop the head from confirming any later snapshot. To free it, submit any transaction in the head: once the deposit has expired, the snapshot that confirms the transaction drops it, and the recovery can go ahead. That needs funds in the head that this node can spend, and no snapshot round stuck in flight. Otherwise close the head, and recover the deposit after its deadline once the head shows as Closed here';

/**
 * Refuse to recover a deposit that a head not yet closed has acknowledged in
 * a snapshot it signed. Null when the recovery may go ahead.
 *
 * Such a snapshot keeps the deposit in `utxoToCommit` until a later snapshot
 * replaces it. Recovering the deposit clears the node's record of the deposit
 * in flight, so the next deposit makes the leader request a snapshot that every
 * node rejects (`ReqSnCommitNotSettled`), and that leader then requests no
 * other snapshot. A side-load of a confirmed snapshot, which is how a round is
 * reset, clears the record too, which is why the refusal does not suggest one.
 * Left alone, the record holds the next deposit back, and once this deposit
 * has expired the next transaction's snapshot drops it (hydra-node 2.4.1
 * `HeadLogic`).
 */
async function refuseAcknowledgedDeposit(
	node: HydraNode,
	depositTxHash: string,
	nodeDeadline: Date | null,
): Promise<DepositRecovery | null> {
	let acknowledgedDeposits: HydraAcknowledgedDeposit[];
	try {
		acknowledgedDeposits = await fetchHydraAcknowledgedDeposits(node);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'unknown error';
		logger.warn(`hydra: could not check whether the head acknowledged deposit ${depositTxHash}: ${message}`);
		// A reason rather than an error status: a 5xx message is replaced by its
		// status text in production, and the operator needs the cause. No promise
		// that a retry helps: an answer over the byte limit repeats on every try.
		return {
			depositTxHash,
			requested: false,
			reason: `could not check whether the head has acknowledged this deposit (${message}), so it was not recovered`,
		};
	}
	const depositTxId = depositTxHash.toLowerCase();
	if (!acknowledgedDeposits.some((acknowledged) => acknowledged === null || acknowledged === depositTxId)) {
		return null;
	}
	// An increment can claim a deposit only before its deadline, and the node
	// recovers one only after it (hydra-node 2.4.1 `deposit.ak`). Past the
	// deadline this deposit will never be absorbed, so waiting does not help.
	// Without a recorded deadline nobody here can say it will be.
	const isAbsorbable = nodeDeadline !== null && nodeDeadline.getTime() > Date.now();
	if (isAbsorbable) {
		return {
			depositTxHash,
			requested: false,
			reason:
				'the head has acknowledged this deposit in a snapshot it signed and may still absorb it before its deadline. Wait until the head absorbs it or the deadline passes',
		};
	}
	const absorbOutlook =
		nodeDeadline === null
			? 'its deadline is not recorded, so whether the head can still absorb it is unknown'
			: 'its deadline has passed, so the head can no longer absorb it';
	return {
		depositTxHash,
		requested: false,
		reason: `the head acknowledged this deposit in a snapshot it signed, but ${absorbOutlook}. ${RELEASE_ACKNOWLEDGED_DEPOSIT}`,
	};
}

/**
 * Record that this deposit's recovery was asked for.
 *
 * Recovery leaves no other trace on the row: the status describes what the head
 * did with the deposit, and the head did nothing. Without this the row reads as
 * untouched after a recovery — the button comes back on the next page load and
 * invites a second press at funds already on their way home.
 *
 * Only ever set once, so a repeat press cannot move the timestamp forward and
 * make an old recovery look new.
 */
async function markRecoveryRequested(topupId: string): Promise<void> {
	try {
		await prisma.hydraTopup.updateMany({
			where: { id: topupId, recoveryRequestedAt: null },
			data: { recoveryRequestedAt: new Date() },
		});
	} catch (error) {
		// The request may already have reached the node. Failing to note it must
		// not turn the attempt into an error that invites a blind retry.
		logger.warn(`hydra: could not record the recovery request for ${topupId}`, { error });
	}
}
