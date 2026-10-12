import createHttpError from 'http-errors';
import { GuardedHydraTransferDirection, GuardedHydraTransferStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraTransportAmbiguousError } from '@/lib/hydra/hydra/errors';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
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
	if (node == null) throw createHttpError(502, 'No connection to the Hydra head');

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
		throw createHttpError(409, `The node would not recover this deposit: ${message}`);
	}
	logger.info('Requested recovery of a guarded wallet deposit', { transferId: transfer.id });
	return { transfer: transferView(transfer), reason: null };
}
