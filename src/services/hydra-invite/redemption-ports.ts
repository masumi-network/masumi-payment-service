/**
 * The real collaborators of a recorded redemption: the database, the redeemer's
 * own Hydra Host, and the issuer's exchange. `redemption.ts` holds the logic and
 * knows none of them.
 */
import createHttpError from 'http-errors';
import {
	HydraHeadStatus,
	HydraInviteRole,
	HydraInviteStatus,
	type Network,
	type Prisma,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { decrypt } from '@/utils/security/encryption';
import {
	checkHostPeerTarget,
	fetchHostNodePeers,
	setHostNodePeers,
	startHostNode,
	type HostPeer,
} from '@/services/hydra-host/client';
import { withHostPauseLease } from '@/services/hydra-host/pause';
import { attemptRedemption, type ExchangeTransportOptions } from './exchange-client';
import type { createHeadFromExchange } from './orchestrator';
import type { RedemptionPorts, RedemptionState } from './redemption';
import {
	LIVE_REDEEMER_STATUSES,
	claimUnconfirmed,
	discardUnlanded,
	failUnconfirmed,
	linkRedeemerToHead,
	markAcknowledged,
	markStarted,
} from './redemption-store';

export type RedeemerRecord = Prisma.HydraHeadInviteGetPayload<{
	include: { LocalHotWallet: true; HydraHost: true };
}>;

/**
 * Refuse a redemption that cannot become a head, before anything is spent.
 *
 * A pair has at most one head that is not final, so an invite redeemed while one
 * exists, or while another acknowledged redemption with the same counterparty is
 * still owed its head, burns its nonce and then cannot be finished. `excludeInviteId` is the
 * redemption that is asking, so it does not count against itself.
 */
export async function assertRelationHasNoLiveHead(input: {
	network: Network;
	localHotWalletId: string;
	counterpartyWalletAddress: string;
	excludeInviteId?: string;
}): Promise<void> {
	const liveHead = await prisma.hydraHead.findFirst({
		where: {
			status: { not: HydraHeadStatus.Final },
			retiredAt: null,
			HydraRelation: {
				network: input.network,
				localHotWalletId: input.localHotWalletId,
				RemoteWallet: { walletAddress: input.counterpartyWalletAddress },
			},
		},
		select: { status: true },
	});
	if (liveHead !== null) {
		throw createHttpError(
			409,
			`you already have a ${liveHead.status.toLowerCase()} head with this counterparty on ${input.network}; ` +
				'close and settle it before opening another, then ask them for a new invite',
		);
	}
	const pending = await prisma.hydraHeadInvite.findFirst({
		where: {
			role: HydraInviteRole.Redeemer,
			network: input.network,
			localHotWalletId: input.localHotWalletId,
			issuerWalletAddress: input.counterpartyWalletAddress,
			status: { in: [...LIVE_REDEEMER_STATUSES] },
			// Only a redemption the issuer acknowledged is owed a head. One whose answer
			// was lost may never have spent anything, and must not keep a fresh invite
			// from the same counterparty waiting for days.
			redeemedAt: { not: null },
			...(input.excludeInviteId === undefined ? {} : { id: { not: input.excludeInviteId } }),
		},
		select: { status: true },
	});
	if (pending !== null) {
		throw createHttpError(
			409,
			`a redemption with this counterparty is already in progress on ${input.network}; ` +
				'let it finish, or discard it, before redeeming another invite from them',
		);
	}
}

export function toRedemptionState(record: RedeemerRecord): RedemptionState {
	// Only a live redemption has anything left to do. A finished or failed one
	// would otherwise read as one waiting for its node, and have it started.
	if (!LIVE_REDEEMER_STATUSES.some((status) => status === record.status)) {
		throw createHttpError(409, `redemption ${record.id} is ${record.status}, not one that can be carried on`);
	}
	return {
		status: record.status === HydraInviteStatus.Started ? 'Started' : 'Redeemed',
		acknowledged: record.redeemedAt !== null,
		hostPaused: record.HydraHost.pausedAt !== null,
		issuerPeer: {
			advertise: record.issuerAdvertise,
			hydraVerificationKey: record.issuerHydraVerificationKey,
			cardanoVerificationKey: record.issuerCardanoVerificationKey,
		},
	};
}

function hostAccess(record: RedeemerRecord) {
	const host = record.HydraHost;
	if (host.encryptedAdminToken === null) {
		throw createHttpError(409, 'the hydra host holding this node has no admin token');
	}
	return {
		baseUrl: host.baseUrl,
		adminToken: decrypt(host.encryptedAdminToken),
		transport: { allowInsecureHttp: host.allowInsecureHttp },
	};
}

export function buildRedemptionPorts(input: {
	record: RedeemerRecord;
	/** The operator's opt-ins on a request. The resume job, which has none stored, sends with neither. */
	transport: ExchangeTransportOptions;
	createHead: typeof createHeadFromExchange;
}): RedemptionPorts {
	const { record, transport, createHead } = input;
	// The `updatedAt` this caller last saw. Every write that could end the record
	// names it, so a claim by anyone else makes those writes find nothing.
	let version = record.updatedAt;

	return {
		claim: async () => {
			// Strictly later than what it replaces, even within the same millisecond,
			// or the claim would leave the creator's write still matching.
			const next = new Date(Math.max(Date.now(), version.getTime() + 1));
			const claimed = await claimUnconfirmed(record.id, version, next);
			if (claimed) version = next;
			return claimed;
		},

		checkPeerTarget: async (advertise) => {
			const host = hostAccess(record);
			return await checkHostPeerTarget(host.baseUrl, host.adminToken, advertise, host.transport);
		},

		assertNoCompetingRedemption: async () => {
			await assertRelationHasNoLiveHead({
				network: record.network,
				localHotWalletId: record.localHotWalletId,
				counterpartyWalletAddress: record.issuerWalletAddress,
				excludeInviteId: record.id,
			});
		},

		post: async () => {
			const { redeemerWalletAddress, redeemerHydraVerificationKey, redeemerCardanoVerificationKey } = record;
			const { redeemerAdvertise, redeemerExchangeUrl, redeemerSignature, redeemerSignerKey } = record;
			if (
				redeemerWalletAddress === null ||
				redeemerHydraVerificationKey === null ||
				redeemerCardanoVerificationKey === null ||
				redeemerAdvertise === null ||
				redeemerExchangeUrl === null ||
				redeemerSignature === null ||
				redeemerSignerKey === null
			) {
				throw createHttpError(500, 'this redemption record is incomplete and cannot be sent');
			}
			return await attemptRedemption(
				record.issuerExchangeUrl,
				{
					nonce: record.nonce,
					redeemer: {
						walletAddress: redeemerWalletAddress,
						hydraVerificationKey: redeemerHydraVerificationKey,
						cardanoVerificationKey: redeemerCardanoVerificationKey,
						advertise: redeemerAdvertise,
						exchangeUrl: redeemerExchangeUrl,
					},
					signature: { signature: redeemerSignature, key: redeemerSignerKey },
				},
				transport,
			);
		},

		markAcknowledged: async () => await markAcknowledged(record.id),

		// The reservation stays with its node. A retry replays it by nonce, and the
		// abandoned-reservation sweep returns it after an hour if nobody retries.
		discard: async () => await discardUnlanded(record.id, version),

		// The node is left to the abandoned-reservation sweep, which takes a failed
		// record's node and settles its fuel on chain first. Doing that here would
		// hold a request, or a whole resume pass, on chain queries.
		fail: async () => await failUnconfirmed(record.id, version),

		currentPeers: async () => {
			const host = hostAccess(record);
			return await fetchHostNodePeers(host.baseUrl, host.adminToken, record.hostNodeId, host.transport);
		},

		setPeers: async (peers: HostPeer[]) => {
			const host = hostAccess(record);
			await setHostNodePeers(host.baseUrl, host.adminToken, record.hostNodeId, peers, host.transport);
		},

		start: async () => {
			const host = hostAccess(record);
			// Rotation, Resume and this start share the lease. A token cannot be
			// saved between the pause check and the Host's start response.
			const acted = await withHostPauseLease(record.hydraHostId, async () => {
				const current = await prisma.hydraHost.findUnique({
					where: { id: record.hydraHostId },
					select: { pausedAt: true },
				});
				if (!current || current.pausedAt !== null) {
					throw createHttpError(
						409,
						'your Hydra Host was paused for maintenance; the redemption continues once it is resumed',
					);
				}
				await startHostNode(host.baseUrl, host.adminToken, record.hostNodeId, host.transport);
			});
			if (!acted) throw createHttpError(409, 'another Host pause action is running; retry the redemption shortly');
		},

		markStarted: async () => await markStarted(record.id),

		createHead: async () => {
			const participant = await prisma.hydraLocalParticipant.findFirst({
				where: { hydraHostId: record.hydraHostId, hostNodeId: record.hostNodeId },
				select: { id: true },
			});
			if (participant === null) {
				throw createHttpError(
					409,
					'the node reserved for this invite has no local participant here, so no head can be created for it',
				);
			}
			const head = await createHead({
				network: record.network,
				paymentSourceId: record.LocalHotWallet.paymentSourceId,
				localHotWalletId: record.localHotWalletId,
				localParticipantId: participant.id,
				counterpartyWalletAddress: record.issuerWalletAddress,
				counterpartyExchangeUrl: record.issuerExchangeUrl,
				counterpartyHydraVerificationKey: record.issuerHydraVerificationKey,
				counterpartyCardanoVerificationKey: record.issuerCardanoVerificationKey,
				counterpartyAdvertise: record.issuerAdvertise,
				contestationPeriodSeconds: record.contestationPeriodSeconds,
				linkInvite: async (tx, hydraHeadId) => await linkRedeemerToHead(tx, record.id, hydraHeadId),
			});
			return { hydraHeadId: head.hydraHeadId };
		},

		reload: async () =>
			await prisma.hydraHeadInvite.findUnique({
				where: { id: record.id },
				select: { status: true, hydraHeadId: true },
			}),
	};
}
