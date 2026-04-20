import { prisma } from '@/utils/db';
import {
	type Network,
	type HydraHead,
	type HydraLocalParticipant,
	type HydraRemoteParticipant,
	HydraHeadStatus,
} from '@/generated/prisma/client';

export interface UsableHydraHead {
	hydraHead: HydraHead;
	localParticipant: HydraLocalParticipant;
	remoteParticipants: HydraRemoteParticipant[];
	hydraRelationId: string;
}

/**
 * Resolves an open, enabled Hydra head where the given HotWallet is the local
 * participant and the given WalletBase is the remote counterparty.
 */
export async function resolveUsableHydraHead(
	localHotWalletId: string,
	remoteWalletId: string,
	network: Network,
): Promise<UsableHydraHead | null> {
	const relation = await prisma.hydraRelation.findUnique({
		where: {
			network_localHotWalletId_remoteWalletId: {
				network,
				localHotWalletId,
				remoteWalletId,
			},
		},
		include: {
			Heads: {
				where: {
					isEnabled: true,
					headIdentifier: { not: null },
					status: 'Open',
				},
				include: {
					LocalParticipant: true,
					RemoteParticipants: true,
				},
				take: 1,
			},
		},
	});

	if (!relation || relation.Heads.length === 0) {
		return null;
	}

	const head = relation.Heads[0];
	if (!head.LocalParticipant) {
		return null;
	}

	return {
		hydraHead: head,
		localParticipant: head.LocalParticipant,
		remoteParticipants: head.RemoteParticipants,
		hydraRelationId: relation.id,
	};
}

/**
 * Resolves an open Hydra head where the given HotWallet is the local participant
 * and the remote counterparty matches the given WalletBase.
 *
 * Used in the purchase flow where the buyer's HotWallet is the local participant
 * and the seller is identified by their WalletBase.
 */
export async function resolveUsableHydraHeadForPurchase(
	buyerHotWalletId: string,
	sellerWalletBaseId: string,
	network: Network,
): Promise<UsableHydraHead | null> {
	const head = await prisma.hydraHead.findFirst({
		where: {
			isEnabled: true,
			headIdentifier: { not: null },
			status: HydraHeadStatus.Open,
			LocalParticipant: {
				walletId: buyerHotWalletId,
			},
			HydraRelation: {
				network,
				remoteWalletId: sellerWalletBaseId,
			},
		},
		include: {
			LocalParticipant: true,
			RemoteParticipants: true,
		},
	});

	if (!head || !head.LocalParticipant) {
		return null;
	}

	return {
		hydraHead: head,
		localParticipant: head.LocalParticipant,
		remoteParticipants: head.RemoteParticipants,
		hydraRelationId: head.hydraRelationId,
	};
}
