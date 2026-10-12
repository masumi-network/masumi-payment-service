import createHttpError from 'http-errors';
import { GuardedHydraTransferDirection, GuardedHydraTransferStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraTransportAmbiguousError } from '@/lib/hydra/hydra/errors';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { recoverDepositWithoutNode } from '@/services/hydra-deposit-recovery/recover-on-l1';
import { findGuardedWalletInHead } from './location';
import { loadGuardedHotWallet, transferView } from './transfers';

type Scope = Parameters<typeof loadGuardedHotWallet>[1];

/**
 * Get back a guarded wallet deposit the head never took in.
 *
 * The deposit locks the wallet UTxO at the Hydra deposit script, not at the
 * wallet address. If the head never increments, the wallet stays there and every
 * new move is blocked by this open transfer. Only the head's node can spend it
 * back, and only after the deadline in the deposit datum (`recoverableAt`). The
 * recover transaction recreates the wallet output with its datum and state token
 * and the node pays the fee, so the owner signs nothing. The status read settles
 * the transfer once the wallet is on L1 again.
 *
 * Without a live node (head closed, disabled or quarantined) the service posts the
 * same recover on L1 itself, and the agent hot wallet pays the fee.
 */
export async function recoverGuardedDeposit(input: { transferId: string }, scope: Scope) {
	const transfer = await prisma.guardedHydraTransfer.findUnique({
		where: { id: input.transferId },
		include: { GuardedWallet: true },
	});
	if (transfer == null || transfer.direction !== GuardedHydraTransferDirection.Deposit) {
		throw createHttpError(404, 'Deposit not found');
	}
	// Scope: the caller must be able to see the hot wallet this deposit moves.
	const { guarded } = await loadGuardedHotWallet(transfer.GuardedWallet.hotWalletId, scope);
	if (transfer.status !== GuardedHydraTransferStatus.Submitted) {
		throw createHttpError(409, `The deposit is ${transfer.status}; only a Submitted deposit can be recovered`);
	}
	if (transfer.recoverableAt == null || transfer.recoverableAt.getTime() > Date.now()) {
		throw createHttpError(
			409,
			`The node recovers a deposit only after its deadline (${transfer.recoverableAt?.toISOString() ?? 'unknown'})`,
		);
	}
	const inHead = await findGuardedWalletInHead(transfer.GuardedWallet.hotWalletId, guarded);
	if (inHead?.hydraHeadId === transfer.hydraHeadId) {
		throw createHttpError(409, 'The head already holds the wallet; read the status to settle this deposit');
	}
	const node = getHydraConnectionManager().getNode(transfer.hydraHeadId);
	if (node == null) {
		const head = await prisma.hydraHead.findUnique({
			where: { id: transfer.hydraHeadId },
			select: { headIdentifier: true },
		});
		const { recoverTxHash } = await recoverDepositWithoutNode({
			hotWalletId: transfer.GuardedWallet.hotWalletId,
			depositTxHash: transfer.txHash,
			headIdentifier: head?.headIdentifier ?? null,
		});
		logger.info('Recovered a guarded wallet deposit on L1 without the node', {
			transferId: transfer.id,
			recoverTxHash,
		});
		return {
			transfer: transferView(transfer),
			reason: `No live node for the head; the service posted recover ${recoverTxHash} on L1. Read the status once it confirms`,
		};
	}

	try {
		await node.delete(`/commits/${transfer.txHash}`);
	} catch (error) {
		// The node builds and submits the recover tx before it answers, so a lost answer is the usual case.
		if (error instanceof HydraTransportAmbiguousError) {
			logger.info('Recovery of a guarded wallet deposit was requested; the node did not answer in time', {
				transferId: transfer.id,
			});
			return {
				transfer: transferView(transfer),
				reason: 'The node did not answer in time. The recovery is likely posted; read the status',
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		logger.warn('The node refused to recover a guarded wallet deposit', { transferId: transfer.id, error: message });
		// A deposit already recovered, or one the head took in after all, is refused too: the status read tells which.
		throw createHttpError(
			409,
			`The node would not recover this deposit: ${message}. If recovery was already requested, read the status`,
		);
	}
	logger.info('Requested recovery of a guarded wallet deposit', { transferId: transfer.id });
	return { transfer: transferView(transfer), reason: null };
}
