import { TransactionLayer } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import type { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { isBoundFanoutOutputOrigin } from '@/lib/hydra/hydra/fanout-output-origin';
import type { HydraFanoutChainObserver } from '@/lib/hydra/hydra/fanout-validation';

export class PendingFanoutHandoffError extends Error {
	constructor(readonly hydraHeadId: string) {
		super(`Hydra head ${hydraHeadId} is fanning out; retry this L1 spend after its final handoff`);
		this.name = 'PendingFanoutHandoffError';
	}
}

/** A partial fanout can expose an L1 output while its request still names an L2 predecessor. */
export async function deferSpendUntilFanoutHandoff(
	candidate: {
		layer: TransactionLayer;
		CurrentTransaction: { hydraHeadId: string | null; layer: TransactionLayer } | null;
	} | null,
	input: { tx_hash: string; output_index: number; amount: Array<{ unit: string; quantity: string }> },
	contractAddress: string,
	blockfrost: BlockFrostAPI,
): Promise<void> {
	if (candidate?.layer !== TransactionLayer.L2 || candidate.CurrentTransaction?.layer !== TransactionLayer.L2) return;
	const hydraHeadId = candidate.CurrentTransaction.hydraHeadId;
	if (hydraHeadId == null) return;
	const head = await prisma.hydraHead.findUnique({
		where: { id: hydraHeadId },
		select: {
			headIdentifier: true,
			LocalParticipant: { select: { cardanoVkey: true } },
			RemoteParticipants: { select: { cardanoVkey: true } },
		},
	});
	// The service's status can lag the first partial fanout block. The producer
	// proof, rather than that status, decides whether this L1 spend must wait.
	if (head?.headIdentifier == null || head.LocalParticipant == null || head.RemoteParticipants.length !== 1)
		throw new PendingFanoutHandoffError(hydraHeadId);
	const isBound = await isBoundFanoutOutputOrigin({
		observer: blockfrost as unknown as HydraFanoutChainObserver,
		headId: head.headIdentifier,
		participantVkeys: [head.LocalParticipant.cardanoVkey, head.RemoteParticipants[0].cardanoVkey],
		producerTxHash: input.tx_hash,
		outputIndex: input.output_index,
		indexedAmounts: input.amount,
		contractAddress,
	});
	if (isBound) throw new PendingFanoutHandoffError(hydraHeadId);
}
