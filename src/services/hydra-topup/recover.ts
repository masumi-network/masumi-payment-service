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
import { HydraTopupStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { HydraTransportAmbiguousError } from '@/lib/hydra/hydra/errors';

export type DepositRecovery = {
	/** Null while the top-up is still being prepared and has no deposit yet. */
	depositTxHash: string | null;
	/** Null when nothing was posted, with `reason` saying why. */
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

	const manager = getHydraConnectionManager();
	const node = manager.getNode(topup.hydraHeadId);
	if (node === null) {
		throw createHttpError(
			502,
			'no live connection to this head’s node, so the recovery cannot be requested. Check the connection and try again',
		);
	}

	try {
		await node.delete(`/commits/${topup.depositTxHash}`);
	} catch (error) {
		// Building and submitting the recover transaction takes longer than the
		// HTTP client waits, so a lost response is the normal case rather than a
		// refusal: the node posts it anyway. Reported as requested, because that
		// is what happened, with the caller told where to look.
		if (error instanceof HydraTransportAmbiguousError) {
			logger.info(`hydra: recovery of deposit ${topup.depositTxHash} was requested; the node did not answer in time`);
			await markRecoveryRequested(topup.id);
			return {
				depositTxHash: topup.depositTxHash,
				requested: true,
				reason: 'the node took longer than the request window to answer. The recovery is posted; watch the wallet',
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
		// The recovery is already posted; failing to note it must not turn a
		// successful request into an error the caller retries.
		logger.warn(`hydra: could not record the recovery request for ${topupId}`, { error });
	}
}
