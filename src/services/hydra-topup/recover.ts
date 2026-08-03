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

export type DepositRecovery = {
	depositTxHash: string;
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
	const topup = await prisma.hydraTopup.findUniqueOrThrow({
		where: { id: topupId },
		select: {
			id: true,
			depositTxHash: true,
			status: true,
			hydraHeadId: true,
		},
	});

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
		// The node refuses before the deadline, which is the common answer rather
		// than a fault: it is what stops a recovery racing an increment.
		const message = error instanceof Error ? error.message : 'the node refused the recovery';
		logger.warn(`hydra: recovery of deposit ${topup.depositTxHash} was refused: ${message}`);
		throw createHttpError(409, `the node would not recover this deposit yet: ${message}`);
	}

	logger.info(`hydra: requested recovery of deposit ${topup.depositTxHash} for head ${topup.hydraHeadId}`);
	return { depositTxHash: topup.depositTxHash, requested: true, reason: null };
}
