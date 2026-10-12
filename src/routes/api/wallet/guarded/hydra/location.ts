import type { UTxO } from '@meshsdk/core';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { fetchPendingCommitRefs } from '@/lib/hydra/hydra/pending-commit';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';

export type GuardedWalletInHead = {
	hydraHeadId: string;
	walletUtxo: UTxO;
	snapshot: UTxO[];
	/** False when `/head` could not be read: the wallet UTxO may still wait for its commit to finalize. */
	isCommitStateKnown: boolean;
};

/** A guarded wallet is identified by its state token, never by address or datum shape. */
export function stateTokenUnit(guarded: { policyId: string; stateTokenName: string }): string {
	return `${guarded.policyId}${guarded.stateTokenName}`;
}

export function findStateTokenUtxo(utxos: UTxO[], unit: string): UTxO | null {
	const held = utxos.filter((utxo) =>
		utxo.output.amount.some((asset) => asset.unit === unit && BigInt(asset.quantity) === 1n),
	);
	return held.length === 1 ? held[0] : null;
}

/**
 * Where the wallet is on L2, read live from the snapshot of every open head the
 * hot wallet takes part in. No stored location can drift from the head's own
 * view. Null when no connected head holds the state token.
 */
export async function findGuardedWalletInHead(
	hotWalletId: string,
	guarded: { policyId: string; stateTokenName: string },
): Promise<GuardedWalletInHead | null> {
	const heads = await prisma.hydraHead.findMany({
		where: { isEnabled: true, status: HydraHeadStatus.Open, LocalParticipant: { walletId: hotWalletId } },
		select: { id: true },
	});
	const unit = stateTokenUnit(guarded);
	for (const head of heads) {
		const node = getHydraConnectionManager().getNode(head.id);
		if (node == null) continue;
		let snapshot: UTxO[];
		try {
			snapshot = await node.snapshotUTxO();
		} catch (error) {
			logger.warn('Could not read a head snapshot while locating a guarded wallet', {
				hydraHeadId: head.id,
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		const walletUtxo = findStateTokenUtxo(snapshot, unit);
		if (walletUtxo == null) continue;
		// Approved but not finalized: the snapshot lists it, the ledger cannot spend it yet.
		let pending: string[];
		let isCommitStateKnown = true;
		try {
			pending = await fetchPendingCommitRefs(node);
		} catch (error) {
			// The head holds the wallet either way. Saying it does not would let status report it as moving.
			// The worst case of assuming nothing is pending is one rejected spend.
			logger.warn('Could not read the head state while locating a guarded wallet', {
				hydraHeadId: head.id,
				error: error instanceof Error ? error.message : String(error),
			});
			pending = [];
			isCommitStateKnown = false;
		}
		const ref = `${walletUtxo.input.txHash}#${walletUtxo.input.outputIndex}`.toLowerCase();
		if (pending.includes(ref)) continue;
		// Collateral is picked from this snapshot too, so no pending UTxO may stay in it.
		const usable = snapshot.filter(
			(utxo) => !pending.includes(`${utxo.input.txHash}#${utxo.input.outputIndex}`.toLowerCase()),
		);
		return { hydraHeadId: head.id, walletUtxo, snapshot: usable, isCommitStateKnown };
	}
	return null;
}
