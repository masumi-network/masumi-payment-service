/**
 * Minting and redeeming head invites.
 *
 * Two operations, deliberately asymmetric. Minting reserves a node and signs
 * everything a counterparty needs; redeeming reserves the mirror node, sends
 * our material to the issuer's Exchange Plane, and creates the Relation and
 * Head locally. Nothing the issuer's Host sends back is trusted, because it
 * sends nothing back — that is what lets the exchange terminate on a Host with
 * no wallet key. See ADR 0011.
 */

import createHttpError from 'http-errors';
import { createId } from '@paralleldrive/cuid2';
import { HotWalletType, HydraInviteRole, HydraInviteStatus, Network, WalletType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { createBoundHydraHead } from '@/routes/api/hydra/head';
import { registerInviteOnHost, setHostNodePeers, startHostNode } from '@/services/hydra-host/client';
import { deriveNodeCardanoVkey } from './node-keys';
import {
	INVITE_TTL_MS,
	buildHydraRedemptionPayload,
	checkInviteFreshness,
	type HydraHeadInvitePayloadInput,
} from './invite-payload';
import { encodeInviteCode, type DecodedInvite } from './invite-code';
import { signHydraHeadInvite, signHydraRedemption, verifyHydraHeadInvite } from './invite-signing';
import {
	MIN_UNSYNCED_PERIOD_SECONDS,
	defaultPeriodsFor,
	reserveNodeForExchange,
	type HeadPeriods,
} from './provisioning';
import { fundHydraNodeNow } from '@/services/hydra-node-funding/service';
import { postRedemption } from './exchange-client';

type WalletContext = {
	id: string;
	paymentSourceId: string;
	network: Network;
	walletAddress: string;
	encryptedMnemonic: string;
	/** Which side of a trade this wallet plays, as the invite records it. */
	role: 'Buyer' | 'Seller';
};

async function loadWallet(hotWalletId: string): Promise<WalletContext> {
	const wallet = await prisma.hotWallet.findFirst({
		where: { id: hotWalletId, deletedAt: null },
		include: { Secret: true, PaymentSource: true },
	});
	if (!wallet) {
		throw createHttpError(404, 'wallet not found');
	}
	if (wallet.type === HotWalletType.Funding) {
		throw createHttpError(409, 'a funding wallet cannot be a head participant; pick a buying or selling wallet');
	}
	return {
		id: wallet.id,
		paymentSourceId: wallet.paymentSourceId,
		network: wallet.PaymentSource.network,
		walletAddress: wallet.walletAddress,
		encryptedMnemonic: wallet.Secret.encryptedMnemonic,
		role: wallet.type === HotWalletType.Purchasing ? 'Buyer' : 'Seller',
	};
}

/**
 * Where our own invites are redeemed.
 *
 * The host comes from the Host's control-plane URL — same deployment, so the
 * same machine — and the port from what that Host reported about itself when it
 * was connected. Never from a service-wide setting: an invite carries this URL
 * to a counterparty, and with two Hosts a single shared value can only be right
 * for one of them. The other's invites advertise the wrong exchange, the
 * redemption reaches a Host that never issued the nonce, and the counterparty is
 * told 404 for something they did nothing wrong with.
 */
export function exchangeUrlForHost(baseUrl: string, exchangePort: number): string {
	const url = new URL(baseUrl);
	url.port = String(exchangePort);
	url.pathname = '/exchange';
	url.search = '';
	return url.toString().replace(/\/+$/, '');
}

/**
 * The Host's own exchange port, or a refusal.
 *
 * Refusing beats guessing: a wrong port is baked into a signed invite and only
 * fails at the counterparty, minutes later, as a 404 they cannot act on.
 */
function requireExchangePort(node: { hostExchangePort: number | null; hostBaseUrl: string }): number {
	if (node.hostExchangePort === null) {
		throw createHttpError(
			409,
			`the hydra host at ${node.hostBaseUrl} has not reported its exchange port yet. Press Check on the node and try again`,
		);
	}
	return node.hostExchangePort;
}

export type MintedInvite = {
	inviteId: string;
	nonce: string;
	code: string;
	expiresAt: Date;
};

/**
 * Reserve a node and produce a signed invite for it.
 *
 * The node exists and holds a peer port from this moment. It cannot boot — it
 * has no peer — and it cannot be re-pointed later, so an invite that is never
 * redeemed must be revoked or reaped rather than reused.
 */
export async function mintHeadInvite(input: {
	localHotWalletId: string;
	periods?: HeadPeriods;
	ttlMs?: number;
	/** Default. Opt out only if the node's fuel is managed elsewhere. */
	autoFund?: boolean;
	/** Any of the three periods may be overridden; the rest keep their defaults. */
	depositPeriodSeconds?: number;
	contestationPeriodSeconds?: number;
	unsyncedPeriodSeconds?: number;
}): Promise<MintedInvite> {
	const wallet = await loadWallet(input.localHotWalletId);
	// Defaulted from the wallet's own network: an hour of settle time protects
	// mainnet funds and only wastes a tester's afternoon on preprod.
	//
	// Per head rather than per fleet, because a head that moves large sums wants
	// a longer settle than one used for small frequent top-ups, and the two can
	// run side by side. It is fixed for the head's life: hydra-node reads
	// --deposit-period at startup and a node serves exactly one head, so changing
	// it means a new head.
	const periods = input.periods ?? {
		...defaultPeriodsFor(wallet.network),
		...(input.depositPeriodSeconds != null ? { depositPeriodSeconds: input.depositPeriodSeconds } : {}),
		...(input.contestationPeriodSeconds != null ? { contestationPeriodSeconds: input.contestationPeriodSeconds } : {}),
		...(input.unsyncedPeriodSeconds != null ? { unsyncedPeriodSeconds: input.unsyncedPeriodSeconds } : {}),
	};

	// Half the dispute window is a ceiling, not a preference. Hydra's guarantee is
	// that an in-sync node always has at least that long to observe an on-chain
	// event and react to it; a node allowed to go quiet for longer can still
	// believe it is in sync while it has already lost the time it needs to
	// contest. Raising it trades away the only protection the dispute window
	// provides, so it is refused rather than warned about.
	const syncCeiling = Math.floor(periods.contestationPeriodSeconds / 2);
	if (periods.unsyncedPeriodSeconds > syncCeiling) {
		throw createHttpError(
			400,
			`the out-of-sync limit cannot exceed half the dispute window (${syncCeiling}s here). Past that a node can think it is in sync while it has already run out of time to contest a close`,
		);
	}
	// The floor matters as much as the ceiling, and it is the one that bit us.
	// The out-of-sync limit is usually derived rather than given, so a short
	// dispute window silently produces a short limit: two minutes of dispute
	// window gives a sixty-second limit, and preprod block gaps reach 71s. The
	// head then declares itself out of sync several times an hour and refuses
	// commands, which reads as a broken node rather than a chosen setting.
	if (periods.unsyncedPeriodSeconds < MIN_UNSYNCED_PERIOD_SECONDS) {
		throw createHttpError(
			400,
			`the out-of-sync limit works out at ${periods.unsyncedPeriodSeconds}s, below the ${MIN_UNSYNCED_PERIOD_SECONDS}s floor. It is half the dispute window unless set, so raise the dispute window to at least ${MIN_UNSYNCED_PERIOD_SECONDS * 2}s. Ordinary block gaps cross a shorter limit and the head stops accepting commands`,
		);
	}

	const nonce = createId();
	const expiresAt = new Date(Date.now() + (input.ttlMs ?? INVITE_TTL_MS));

	const node = await reserveNodeForExchange(wallet.network, wallet.id, nonce, periods);
	const exchangeUrl = exchangeUrlForHost(node.hostBaseUrl, requireExchangePort(node));

	const payload: HydraHeadInvitePayloadInput = {
		nonce,
		expiresAt: String(expiresAt.getTime()),
		network: wallet.network,
		issuerWalletAddress: wallet.walletAddress,
		issuerWalletRole: wallet.role,
		hydraVerificationKey: node.hydraVerificationKey,
		cardanoVerificationKey: node.cardanoVerificationKey,
		advertise: node.advertise,
		exchangeUrl,
		...periods,
		ledgerParamsHash: node.ledgerParamsHash,
	};
	const signature = await signHydraHeadInvite(payload, {
		encryptedMnemonic: wallet.encryptedMnemonic,
		walletAddress: wallet.walletAddress,
		network: wallet.network,
	});

	// The Host learns the nonce and which node it reserves — never the payload.
	// It cannot check a signature and has no use for one, and keeping the
	// material out of it means a Host compromise reveals nothing about who we
	// are negotiating with.
	await registerInviteOnHost(node.hostBaseUrl, node.adminToken, {
		nonce,
		hostNodeId: node.nodeId,
		expiresAt: expiresAt.getTime(),
	});

	// Deliberately NOT funded here. The issuer never posts the Init — the
	// redeemer does — so this node needs nothing until it posts its own commit,
	// which cannot happen before someone redeems. Funding at mint time would
	// park ADA against an invite that may never be taken up, or be revoked.
	// Adoption funds it, which is the first moment it could be spent.

	const invite = await prisma.hydraHeadInvite.create({
		data: {
			network: wallet.network,
			role: HydraInviteRole.Issuer,
			status: HydraInviteStatus.Issued,
			nonce,
			expiresAt,
			LocalHotWallet: { connect: { id: wallet.id } },
			HydraHost: { connect: { id: node.hostId } },
			hostNodeId: node.nodeId,
			issuerWalletAddress: wallet.walletAddress,
			issuerHydraVerificationKey: node.hydraVerificationKey,
			issuerCardanoVerificationKey: node.cardanoVerificationKey,
			issuerAdvertise: node.advertise,
			issuerExchangeUrl: exchangeUrl,
			issuerSignature: signature.signature,
			issuerSignerKey: signature.key,
			...periods,
			ledgerParamsHash: node.ledgerParamsHash,
		},
	});

	return {
		inviteId: invite.id,
		nonce,
		code: encodeInviteCode({ payload, signature }),
		expiresAt,
	};
}

export type RedeemedInvite = {
	inviteId: string;
	hydraHeadId: string;
	issuerWalletAddress: string;
};

/**
 * Accept someone's invite: reserve our node, send them our material, and record
 * the Relation and Head.
 *
 * The order matters. We provision before sending, because the material is what
 * we are sending. We create the Relation and Head after the send succeeds,
 * because a redemption the issuer never received would leave us holding a head
 * whose counterparty does not know it exists.
 */
export async function redeemHeadInvite(input: {
	invite: DecodedInvite;
	localHotWalletId: string;
	autoFund?: boolean;
}): Promise<RedeemedInvite> {
	const { payload, signature } = input.invite;
	const wallet = await loadWallet(input.localHotWalletId);

	// Authenticity first: everything after this spends real resources.
	await verifyHydraHeadInvite(payload, signature);

	if (payload.network !== wallet.network) {
		throw createHttpError(409, `this invite is for ${payload.network} and the wallet is on ${wallet.network}`);
	}
	if (payload.issuerWalletAddress === wallet.walletAddress) {
		throw createHttpError(409, 'this is our own invite; a head needs two distinct participants');
	}
	// A head carries payments one way. Same-role pairs open perfectly well and
	// then route nothing: every payment falls back to L1, with no error to
	// explain it. Refused here, where it is still one sentence to fix.
	if (payload.issuerWalletRole === wallet.role) {
		const theirs = payload.issuerWalletRole === 'Buyer' ? 'buying' : 'selling';
		const wanted = payload.issuerWalletRole === 'Buyer' ? 'selling' : 'buying';
		throw createHttpError(
			409,
			`this invite is from their ${theirs} wallet, so it has to be redeemed with a ${wanted} wallet. ` +
				'A head runs between a buyer and a seller, and payments only route through it in that direction',
		);
	}
	const freshness = checkInviteFreshness(Number(payload.expiresAt), Date.now());
	if (!freshness.fresh) {
		throw createHttpError(409, freshness.reason);
	}

	const existing = await prisma.hydraHeadInvite.findUnique({ where: { nonce: payload.nonce } });
	if (existing !== null) {
		throw createHttpError(409, 'this invite has already been redeemed here');
	}

	const periods: HeadPeriods = {
		contestationPeriodSeconds: payload.contestationPeriodSeconds,
		depositPeriodSeconds: payload.depositPeriodSeconds,
		unsyncedPeriodSeconds: payload.unsyncedPeriodSeconds,
	};
	const node = await reserveNodeForExchange(wallet.network, wallet.id, payload.nonce, periods);
	const exchangeUrl = exchangeUrlForHost(node.hostBaseUrl, requireExchangePort(node));

	const redemptionPayload = buildHydraRedemptionPayload({
		nonce: payload.nonce,
		network: wallet.network,
		redeemerWalletAddress: wallet.walletAddress,
		hydraVerificationKey: node.hydraVerificationKey,
		cardanoVerificationKey: node.cardanoVerificationKey,
		advertise: node.advertise,
		exchangeUrl,
	});
	const redemptionSignature = await signHydraRedemption(
		{
			nonce: payload.nonce,
			network: wallet.network,
			redeemerWalletAddress: wallet.walletAddress,
			hydraVerificationKey: node.hydraVerificationKey,
			cardanoVerificationKey: node.cardanoVerificationKey,
			advertise: node.advertise,
			exchangeUrl,
		},
		{
			encryptedMnemonic: wallet.encryptedMnemonic,
			walletAddress: wallet.walletAddress,
			network: wallet.network,
		},
	);

	// Funded here, unlike the issuing side: the redeemer is the one that posts
	// Init, and it can do so the moment this returns. Waiting for the scheduled
	// cycle would put a chain confirmation between redeeming and being able to
	// open the head.
	if (input.autoFund !== false) {
		void fundHydraNodeNow(node.localParticipantId).catch((error: unknown) => {
			logger.warn(`hydra: could not pre-fund node ${node.nodeId}: ${(error as Error).message}`);
		});
	}

	await postRedemption(payload.exchangeUrl, {
		nonce: payload.nonce,
		redeemer: {
			walletAddress: redemptionPayload.redeemerWalletAddress,
			hydraVerificationKey: redemptionPayload.hydraVerificationKey,
			cardanoVerificationKey: redemptionPayload.cardanoVerificationKey,
			advertise: redemptionPayload.advertise,
			exchangeUrl: redemptionPayload.exchangeUrl,
		},
		signature: redemptionSignature,
	});

	// Our side of the cluster, which nothing else will do for us. The issuer's
	// Host configures and starts *its* node when the redemption lands; the
	// mirror of that is ours to perform, and without it the node sits peerless
	// and stopped while both sides believe a head exists.
	await setHostNodePeers(node.hostBaseUrl, node.adminToken, node.nodeId, [
		{
			advertise: payload.advertise,
			hydraVerificationKey: payload.hydraVerificationKey,
			cardanoVerificationKey: payload.cardanoVerificationKey,
		},
	]);
	await startHostNode(node.hostBaseUrl, node.adminToken, node.nodeId);

	const head = await createHeadFromExchange({
		network: wallet.network,
		paymentSourceId: wallet.paymentSourceId,
		localHotWalletId: wallet.id,
		localParticipantId: node.localParticipantId,
		counterpartyWalletAddress: payload.issuerWalletAddress,
		counterpartyExchangeUrl: payload.exchangeUrl,
		counterpartyHydraVerificationKey: payload.hydraVerificationKey,
		counterpartyCardanoVerificationKey: payload.cardanoVerificationKey,
		counterpartyAdvertise: payload.advertise,
		contestationPeriodSeconds: payload.contestationPeriodSeconds,
	});

	const invite = await prisma.hydraHeadInvite.create({
		data: {
			network: wallet.network,
			role: HydraInviteRole.Redeemer,
			status: HydraInviteStatus.Completed,
			nonce: payload.nonce,
			expiresAt: new Date(Number(payload.expiresAt)),
			LocalHotWallet: { connect: { id: wallet.id } },
			HydraHost: { connect: { id: node.hostId } },
			hostNodeId: node.nodeId,
			issuerWalletAddress: payload.issuerWalletAddress,
			issuerHydraVerificationKey: payload.hydraVerificationKey,
			issuerCardanoVerificationKey: payload.cardanoVerificationKey,
			issuerAdvertise: payload.advertise,
			issuerExchangeUrl: payload.exchangeUrl,
			issuerSignature: signature.signature,
			issuerSignerKey: signature.key,
			redeemedAt: new Date(),
			redeemerWalletAddress: wallet.walletAddress,
			redeemerHydraVerificationKey: node.hydraVerificationKey,
			redeemerCardanoVerificationKey: node.cardanoVerificationKey,
			redeemerAdvertise: node.advertise,
			redeemerExchangeUrl: exchangeUrl,
			redeemerSignature: redemptionSignature.signature,
			redeemerSignerKey: redemptionSignature.key,
			...periods,
			ledgerParamsHash: payload.ledgerParamsHash,
			HydraHead: { connect: { id: head.hydraHeadId } },
		},
	});

	logger.info(`hydra: redeemed invite ${payload.nonce} from ${payload.issuerWalletAddress}`);
	return { inviteId: invite.id, hydraHeadId: head.hydraHeadId, issuerWalletAddress: payload.issuerWalletAddress };
}

/**
 * Turn one completed exchange into a Relation, a Head and its two participants.
 *
 * The Relation is found or created rather than assumed: two invites with the
 * same counterparty share one, which is what makes a later Head on that
 * Relation the sequential Head the domain expects rather than a parallel one.
 * Creating the head itself goes through createBoundHydraHead, which holds the
 * relation row and enforces one non-Final head per relation — so a second
 * exchange with a counterparty we already have a live head with fails there
 * rather than here.
 */
export async function createHeadFromExchange(input: {
	network: Network;
	paymentSourceId: string;
	localHotWalletId: string;
	localParticipantId: string;
	counterpartyWalletAddress: string;
	counterpartyExchangeUrl: string;
	counterpartyHydraVerificationKey: string;
	counterpartyCardanoVerificationKey: string;
	counterpartyAdvertise: string;
	contestationPeriodSeconds: number;
}): Promise<{ hydraHeadId: string; hydraRelationId: string }> {
	const { resolvePaymentKeyHash } = await import('@meshsdk/core');
	// Derived here, never accepted from the wire: the vkey is what a Relation is
	// keyed on, so taking a caller's word for it would let one wallet be filed
	// under another's identity.
	const counterpartyVkey = resolvePaymentKeyHash(input.counterpartyWalletAddress);

	const remoteWallet = await prisma.walletBase.upsert({
		where: {
			paymentSourceId_walletVkey_walletAddress_type: {
				paymentSourceId: input.paymentSourceId,
				walletVkey: counterpartyVkey,
				walletAddress: input.counterpartyWalletAddress,
				type: WalletType.Seller,
			},
		},
		create: {
			paymentSourceId: input.paymentSourceId,
			walletVkey: counterpartyVkey,
			walletAddress: input.counterpartyWalletAddress,
			type: WalletType.Seller,
			note: 'hydra counterparty',
		},
		update: {},
	});

	const relation = await prisma.hydraRelation.upsert({
		where: {
			network_localHotWalletId_remoteWalletId: {
				network: input.network,
				localHotWalletId: input.localHotWalletId,
				remoteWalletId: remoteWallet.id,
			},
		},
		create: {
			network: input.network,
			localHotWalletId: input.localHotWalletId,
			remoteWalletId: remoteWallet.id,
			counterpartyBaseUrl: input.counterpartyExchangeUrl,
		},
		// Their exchange URL may have moved since the last head; the newest
		// invite is the better source.
		update: { counterpartyBaseUrl: input.counterpartyExchangeUrl },
	});

	// The counterparty's node identity, not their funding wallet: the InitTx
	// mints the participant token for this key hash, while the wallet on the
	// relation is who they settle with.
	const remoteParticipant = await prisma.hydraRemoteParticipant.create({
		data: {
			Wallet: { connect: { id: remoteWallet.id } },
			cardanoVkey: deriveNodeCardanoVkey(input.counterpartyCardanoVerificationKey),
			advertise: input.counterpartyAdvertise,
			HydraVerificationKey: { create: { hydraVK: input.counterpartyHydraVerificationKey } },
		},
	});

	const head = await createBoundHydraHead({
		hydraRelationId: relation.id,
		contestationPeriod: BigInt(input.contestationPeriodSeconds),
		localParticipantId: input.localParticipantId,
		remoteParticipantId: remoteParticipant.id,
	});

	return { hydraHeadId: head.id, hydraRelationId: relation.id };
}
