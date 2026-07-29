/**
 * Drives a head offer from proposal to a started node.
 *
 * This is where node provisioning actually happens. Both sides must agree the
 * full cluster before either node boots, so the sequence is fixed: provision
 * locally, exchange public material, configure peers, then start. Starting
 * earlier would bootstrap an etcd cluster the counterparty cannot join, because
 * `--initial-cluster` is fixed at process start.
 */

import createHttpError from 'http-errors';
import { createId } from '@paralleldrive/cuid2';
import { HydraOfferRole, HydraOfferStatus, type Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { encrypt } from '@/utils/security/encryption';
import { logger } from '@masumi/payment-core/logger';
import {
	acknowledgeEscrowOnHost,
	hostNodeUrls,
	provisionNodeOnHost,
	removeHostNode,
	setHostNodePeers,
} from '@/services/hydra-host/client';
import { assertHostCompatible, selectPlacementHost } from '@/services/hydra-host/placement';
import { decrypt } from '@/utils/security/encryption';
import { fetchHostCapabilities } from '@/services/hydra-host/client';
import { checkOfferFreshness, isOfferInitiator, type HydraHeadOfferPayloadInput } from './offer-payload';
import { canProposeNewOffer, nextOfferAction, type OfferView } from './offer-state';
import { deriveNodeCardanoVkey } from './node-keys';
import { signHydraHeadOffer, type OfferSignature } from './offer-signing';

/** How long a counterparty has to answer before the reservation is released. */
const OFFER_TTL_MS = 15 * 60 * 1000;

type RelationContext = Awaited<ReturnType<typeof loadRelation>>;

async function loadRelation(hydraRelationId: string) {
	const relation = await prisma.hydraRelation.findUnique({
		where: { id: hydraRelationId },
		include: {
			LocalHotWallet: { include: { Secret: true } },
			RemoteWallet: true,
			Heads: { select: { id: true, status: true } },
		},
	});
	if (!relation) {
		throw createHttpError(404, 'hydra relation not found');
	}
	return relation;
}

/** Heads are sequential within a relation, so the next slot is simply the count. */
function nextHeadSequence(relation: RelationContext): number {
	return relation.Heads.length + 1;
}

async function provisionLocalNode(
	relation: RelationContext,
	nonce: string,
	periods: { contestationPeriodSeconds: number; depositPeriodSeconds: number; unsyncedPeriodSeconds: number },
): Promise<{ hostId: string; nodeId: string; advertise: string; hydraVk: string; cardanoVk: string }> {
	const hosts = await prisma.hydraHost.findMany({ where: { network: relation.network } });
	const host = selectPlacementHost(
		hosts.map((row) => ({
			id: row.id,
			name: row.name,
			network: row.network,
			status: row.status,
			hasAdminToken: row.encryptedAdminToken !== null,
		})),
		relation.network,
	);

	const row = hosts.find((candidate) => candidate.id === host.id);
	if (!row || row.encryptedAdminToken === null) {
		throw createHttpError(409, 'selected hydra host has no admin token');
	}
	const adminToken = decrypt(row.encryptedAdminToken);

	// Checked before provisioning, not at first use: a head placed on a host
	// whose ledger differs fails at commit time, far from the cause.
	const capabilities = await fetchHostCapabilities(row.baseUrl, adminToken);
	assertHostCompatible(capabilities, {
		network: capabilities.network,
		ledgerParamsHash: row.ledgerParamsHash,
	});

	// The nonce doubles as the idempotency key, so a retried proposal reuses the
	// same node instead of stranding one.
	const provisioned = await provisionNodeOnHost(row.baseUrl, adminToken, nonce, periods);

	if (provisioned.secrets !== null) {
		await persistNodeSecrets(relation, row.id, provisioned);
		await acknowledgeEscrowOnHost(row.baseUrl, adminToken, provisioned.nodeId);
	}

	return {
		hostId: row.id,
		nodeId: provisioned.nodeId,
		advertise: provisioned.advertise,
		hydraVk: provisioned.hydraVerificationKey,
		cardanoVk: provisioned.cardanoVerificationKey,
	};
}

/**
 * Store the node's keys before acknowledging escrow.
 *
 * Order matters: escrow-ack seals the disclosure path on the Host, so writing
 * our copy first is what makes the material recoverable if anything after this
 * fails.
 */
async function persistNodeSecrets(
	relation: RelationContext,
	hostId: string,
	provisioned: { nodeId: string; secrets: { hydraSigningKey: string } | null; cardanoVerificationKey: string },
): Promise<void> {
	if (provisioned.secrets === null) {
		return;
	}
	const host = await prisma.hydraHost.findUniqueOrThrow({ where: { id: hostId } });
	const urls = hostNodeUrls(host.baseUrl, provisioned.nodeId);

	await prisma.hydraLocalParticipant.create({
		data: {
			Wallet: { connect: { id: relation.localHotWalletId } },
			cardanoVkey: deriveNodeCardanoVkey(provisioned.cardanoVerificationKey),
			nodeUrl: urls.nodeUrl,
			nodeHttpUrl: urls.nodeHttpUrl,
			HydraHost: { connect: { id: hostId } },
			hostNodeId: provisioned.nodeId,
			HydraSecretKey: { create: { hydraSK: encrypt(provisioned.secrets.hydraSigningKey) } },
		},
	});
}

export type ProposeResult = { offerId: string; nonce: string; payload: HydraHeadOfferPayloadInput };

/**
 * Acceptor-side inputs.
 *
 * When answering a counterparty we do not choose the slot, nonce, expiry or
 * periods — those are already signed into their offer, and choosing our own
 * would produce a payload that no longer verifies.
 */
export type AcceptOptions = {
	role: HydraOfferRole;
	headSequence: number;
	nonce: string;
	expiresAt: Date;
	periods: { contestationPeriodSeconds: number; depositPeriodSeconds: number; unsyncedPeriodSeconds: number };
};

/**
 * Start a handshake for the next head on a relation.
 *
 * Only the initiator proposes. Both operators see themselves as "local", so the
 * lower-sorting relation wallet key decides, and each side reaches the same
 * answer without coordinating.
 */
export async function proposeHeadOffer(hydraRelationId: string, accept?: AcceptOptions): Promise<ProposeResult> {
	const relation = await loadRelation(hydraRelationId);
	const isAccepting = accept !== undefined;

	if (!isAccepting) {
		if (relation.counterpartyBaseUrl === null) {
			throw createHttpError(409, 'this relation has no counterparty base URL, so an offer cannot be delivered');
		}
		// Only the initiator proposes; both sides derive the same answer from key
		// order without coordinating.
		if (!isOfferInitiator(relation.LocalHotWallet.walletVkey, relation.RemoteWallet.walletVkey)) {
			throw createHttpError(
				409,
				'this side is the acceptor for this relation; the counterparty proposes, and proposing here would race them',
			);
		}
	}

	const headSequence = accept?.headSequence ?? nextHeadSequence(relation);
	const existing = await prisma.hydraHeadOffer.findFirst({
		where: { hydraRelationId, headSequence },
		orderBy: { createdAt: 'desc' },
	});
	if (!canProposeNewOffer(existing)) {
		throw createHttpError(409, `an offer for head slot ${headSequence} is already in flight`);
	}

	// When accepting, the slot, nonce, expiry and periods come from the offer we
	// are answering: they are already signed, and substituting our own would
	// produce a payload the counterparty cannot verify.
	const nonce = accept?.nonce ?? createId();
	const periods = accept?.periods ?? {
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		unsyncedPeriodSeconds: 1800,
	};
	const expiresAt = accept?.expiresAt ?? new Date(Date.now() + OFFER_TTL_MS);

	const node = await provisionLocalNode(relation, nonce, periods);

	const offer = await prisma.hydraHeadOffer.create({
		data: {
			hydraRelationId,
			headSequence,
			// The acceptor stores the counterparty's nonce prefixed, so both rows can
			// coexist while the nonce column stays globally unique.
			nonce: isAccepting ? `acceptor:${nonce}` : nonce,
			role: accept?.role ?? HydraOfferRole.Offerer,
			status: HydraOfferStatus.Proposed,
			expiresAt,
			ownNodeId: node.nodeId,
			offeredHydraVerificationKey: node.hydraVk,
			offeredCardanoVerificationKey: node.cardanoVk,
			offeredAdvertise: node.advertise,
			contestationPeriodSeconds: periods.contestationPeriodSeconds,
			depositPeriodSeconds: periods.depositPeriodSeconds,
			unsyncedPeriodSeconds: periods.unsyncedPeriodSeconds,
			ledgerParamsHash: null,
		},
	});

	return { offerId: offer.id, nonce, payload: offerPayloadFor(offer, relation.network) };
}

function offerPayloadFor(
	offer: {
		hydraRelationId: string;
		headSequence: number;
		nonce: string;
		expiresAt: Date;
		offeredHydraVerificationKey: string;
		offeredCardanoVerificationKey: string;
		offeredAdvertise: string;
		contestationPeriodSeconds: number;
		depositPeriodSeconds: number;
		unsyncedPeriodSeconds: number;
		ledgerParamsHash: string | null;
	},
	network: Network,
): HydraHeadOfferPayloadInput {
	return {
		hydraRelationId: offer.hydraRelationId,
		headSequence: offer.headSequence,
		nonce: offer.nonce,
		expiresAt: offer.expiresAt.getTime().toString(),
		network,
		hydraVerificationKey: offer.offeredHydraVerificationKey,
		cardanoVerificationKey: offer.offeredCardanoVerificationKey,
		advertise: offer.offeredAdvertise,
		contestationPeriodSeconds: offer.contestationPeriodSeconds,
		depositPeriodSeconds: offer.depositPeriodSeconds,
		unsyncedPeriodSeconds: offer.unsyncedPeriodSeconds,
		ledgerParamsHash: offer.ledgerParamsHash,
	};
}

/** Sign one of our own offers with the relation's local wallet. */
export async function signOwnOffer(
	offerId: string,
): Promise<{ payload: HydraHeadOfferPayloadInput; signature: OfferSignature }> {
	const offer = await prisma.hydraHeadOffer.findUniqueOrThrow({ where: { id: offerId } });
	const relation = await loadRelation(offer.hydraRelationId);
	const payload = offerPayloadFor(offer, relation.network);
	const signature = await signHydraHeadOffer(payload, {
		encryptedMnemonic: relation.LocalHotWallet.Secret.encryptedMnemonic,
		walletAddress: relation.LocalHotWallet.walletAddress,
		network: relation.network,
	});
	return { payload, signature };
}

/** Record the counterparty's material once they accept. */
export async function recordCounterpartyMaterial(
	offerId: string,
	material: { hydraVerificationKey: string; cardanoVerificationKey: string; advertise: string },
	signature: OfferSignature,
): Promise<void> {
	await prisma.hydraHeadOffer.update({
		where: { id: offerId },
		data: {
			status: HydraOfferStatus.Accepted,
			counterpartyHydraVerificationKey: material.hydraVerificationKey,
			counterpartyCardanoVerificationKey: material.cardanoVerificationKey,
			counterpartyAdvertise: material.advertise,
			counterpartySignature: signature.signature,
			counterpartySignerKey: signature.key,
		},
	});
}

function toOfferView(offer: {
	status: HydraOfferStatus;
	role: HydraOfferRole;
	expiresAt: Date;
	counterpartyAdvertise: string | null;
	counterpartyHydraVerificationKey: string | null;
}): OfferView {
	return {
		status: offer.status,
		role: offer.role,
		expiresAtMs: offer.expiresAt.getTime(),
		hasCounterpartyMaterial: offer.counterpartyAdvertise !== null && offer.counterpartyHydraVerificationKey !== null,
		peersConfigured: offer.status === HydraOfferStatus.Configured,
	};
}

/**
 * Move an offer one step forward.
 *
 * Idempotent by design: each step is derived from the persisted state, so a
 * retry after a partial failure resumes rather than repeating.
 */
export async function advanceOffer(offerId: string): Promise<HydraOfferStatus> {
	const offer = await prisma.hydraHeadOffer.findUniqueOrThrow({ where: { id: offerId } });
	const action = nextOfferAction(toOfferView(offer), Date.now());

	switch (action.kind) {
		case 'Idle':
		case 'SendOffer':
			return offer.status;

		case 'ConfigurePeers': {
			const { baseUrl, adminToken } = await hostCredentials(offer.ownNodeId);
			await setHostNodePeers(baseUrl, adminToken, offer.ownNodeId ?? '', [
				{
					advertise: offer.counterpartyAdvertise ?? '',
					hydraVerificationKey: offer.counterpartyHydraVerificationKey ?? '',
					cardanoVerificationKey: offer.counterpartyCardanoVerificationKey ?? '',
				},
			]);
			await prisma.hydraHeadOffer.update({
				where: { id: offerId },
				data: { status: HydraOfferStatus.Configured },
			});
			return HydraOfferStatus.Configured;
		}

		case 'StartNode': {
			const { baseUrl, adminToken, nodeId } = await hostCredentials(offer.ownNodeId);
			await startHostNode(baseUrl, adminToken, nodeId);
			await prisma.hydraHeadOffer.update({ where: { id: offerId }, data: { status: HydraOfferStatus.Started } });
			return HydraOfferStatus.Started;
		}

		case 'Reap': {
			await reapOffer(offerId, action.reason);
			return HydraOfferStatus.Expired;
		}
	}
}

async function hostCredentials(
	hostNodeId: string | null,
): Promise<{ baseUrl: string; adminToken: string; nodeId: string }> {
	if (hostNodeId === null) {
		throw createHttpError(409, 'this offer has no provisioned node');
	}
	const participant = await prisma.hydraLocalParticipant.findFirst({
		where: { hostNodeId },
		include: { HydraHost: true },
	});
	if (!participant?.HydraHost || participant.HydraHost.encryptedAdminToken === null) {
		throw createHttpError(409, 'the host for this node is unknown or has no admin token');
	}
	return {
		baseUrl: participant.HydraHost.baseUrl,
		adminToken: decrypt(participant.HydraHost.encryptedAdminToken),
		nodeId: hostNodeId,
	};
}

async function startHostNode(baseUrl: string, adminToken: string, nodeId: string): Promise<void> {
	const { hydraAuthHeaders } = await import('@/lib/hydra/hydra/auth');
	const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/nodes/${nodeId}/start`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...hydraAuthHeaders(adminToken) },
		redirect: 'error',
	});
	if (!response.ok) {
		throw createHttpError(502, `hydra host refused to start node ${nodeId} (${response.status})`);
	}
}

/**
 * Release what an offer reserved.
 *
 * Both sides allocated a node and a peer port when the offer was made, so an
 * offer that can no longer complete must give them back rather than hold a slot
 * for a head that will never open.
 */
export async function reapOffer(offerId: string, reason: string): Promise<void> {
	const offer = await prisma.hydraHeadOffer.findUnique({ where: { id: offerId } });
	if (!offer) {
		return;
	}
	logger.info(`[hydra-handshake] reaping offer ${offerId}: ${reason}`);

	if (offer.ownNodeId !== null) {
		try {
			const { baseUrl, adminToken, nodeId } = await hostCredentials(offer.ownNodeId);
			// The node never carried a head, so there is no state to protect.
			await removeHostNode(baseUrl, adminToken, nodeId, { force: true });
			await prisma.hydraLocalParticipant.deleteMany({ where: { hostNodeId: offer.ownNodeId, hydraHeadId: null } });
		} catch (error) {
			logger.warn(`[hydra-handshake] could not release node for offer ${offerId}: ${(error as Error).message}`);
		}
	}

	await prisma.hydraHeadOffer.update({ where: { id: offerId }, data: { status: HydraOfferStatus.Expired } });
}

/** Sweep offers whose window has closed. */
export async function reapExpiredOffers(nowMs = Date.now()): Promise<number> {
	const stale = await prisma.hydraHeadOffer.findMany({
		where: {
			status: { in: [HydraOfferStatus.Proposed, HydraOfferStatus.Accepted, HydraOfferStatus.Configured] },
			expiresAt: { lt: new Date(nowMs) },
		},
		select: { id: true },
	});
	for (const offer of stale) {
		await reapOffer(offer.id, 'offer expired');
	}
	return stale.length;
}

export { checkOfferFreshness, offerPayloadFor };
