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
import {
	HotWalletType,
	HydraInviteRole,
	HydraInviteStatus,
	Network,
	PaymentSourceType,
	Prisma,
	WalletType,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { nonceLogRef } from './nonce-log-ref';
import { createBoundHydraHead } from '@/routes/api/hydra/head/create-head';
import { registerInviteOnHost } from '@/services/hydra-host/client';
import { deriveNodeCardanoVkey } from './node-keys';
import { INVITE_TTL_MS, checkInviteFreshness, type HydraHeadInvitePayloadInput } from './invite-payload';
import {
	hashInviteNonce,
	revealInviteNonce,
	revealInviteSignature,
	sealInviteNonce,
	sealInviteSignature,
} from './invite-secrets';
import { encodeInviteCode, type DecodedInvite } from './invite-code';
import { signHydraHeadInvite, signHydraRedemption, verifyHydraHeadInvite } from './invite-signing';
import {
	assertHeadPeriodsAllowed,
	defaultPeriodsFor,
	periodsFromInvite,
	reserveNodeForExchange,
	type HeadPeriods,
} from './provisioning';
import { fundHydraNodeNow } from '@/services/hydra-node-funding/service';
import {
	assertExchangeTransportAllowed,
	resolveExchangeTarget,
	type ExchangeTransportOptions,
} from './exchange-client';
import { advanceRedemption } from './redemption';
import {
	assertRelationHasNoLiveHead,
	buildRedemptionPorts,
	toRedemptionState,
	type RedeemerRecord,
} from './redemption-ports';
import { LIVE_REDEEMER_STATUSES, createRedeemerRecord } from './redemption-store';
import { expectedHostCapabilitiesForNetwork } from '@/services/hydra-host/compatibility';

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
	// In-head escrow exists only in `packages/payment-source-v2`: every L2 lock,
	// result submission and collection is reached through a V2 code path. A head
	// opened on a V1 wallet is therefore openable, fundable and permanently
	// unused — the payments it was opened for keep going to L1 — and the only
	// way out of it is to close the head again. Refused here rather than left to
	// be discovered, because opening one costs about 10 ADA and a counterparty's
	// time.
	if (wallet.PaymentSource.paymentSourceType !== PaymentSourceType.Web3CardanoV2) {
		throw createHttpError(
			409,
			'Hydra heads only carry payments for a Web3CardanoV2 payment source; pick a wallet on a V2 source',
		);
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
 * The Host's own public exchange URL, or a refusal.
 *
 * The Control Plane may be private while the Exchange Plane is public, so the
 * URL cannot be derived from the control URL without breaking that boundary.
 */
function requireExchangeUrl(node: { hostExchangeUrl: string | null; hostBaseUrl: string }): string {
	if (node.hostExchangeUrl === null) {
		throw createHttpError(
			409,
			`the hydra host at ${node.hostBaseUrl} has not reported its public exchange URL. Upgrade the Host and press Check`,
		);
	}
	return node.hostExchangeUrl;
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
		// depositActivationSeconds rides along with an explicit depositPeriodSeconds
		// override, not just the default: every comment on HeadPeriods asserts
		// activation == depositPeriod, and leaving activation at the network
		// default while a caller overrode DP would break that invariant for any
		// head opened through this public knob (see the invite route's
		// depositPeriodSeconds input).
		...(input.depositPeriodSeconds != null
			? { depositPeriodSeconds: input.depositPeriodSeconds, depositActivationSeconds: input.depositPeriodSeconds }
			: {}),
		...(input.contestationPeriodSeconds != null ? { contestationPeriodSeconds: input.contestationPeriodSeconds } : {}),
		...(input.unsyncedPeriodSeconds != null ? { unsyncedPeriodSeconds: input.unsyncedPeriodSeconds } : {}),
	};

	// Refused here rather than at head creation, which is where mainnet's floor
	// used to be checked for the first time: by then this side has a provisioned
	// node with keys, a peer port and its funding, the counterparty has a mirror
	// of all three, and neither can be reused.
	assertHeadPeriodsAllowed(wallet.network, periods);

	const nonce = createId();
	const expiresAt = new Date(Date.now() + (input.ttlMs ?? INVITE_TTL_MS));

	const node = await reserveNodeForExchange(wallet.network, wallet.id, nonce, periods, input.autoFund !== false);
	const exchangeUrl = requireExchangeUrl(node);

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
		// Explicit, not `...periods`: `periods` also carries `depositActivationSeconds`
		// (hydra-node 2.4's LOCAL-only `--deposit-activation`, see `HeadPeriods`),
		// which must never enter the signed invite payload — it is not one of the
		// on-chain-checked `HeadParameters`, so signing it would misrepresent it as
		// something the counterparty needs to agree to. `HydraHeadInvitePayloadInput`
		// has no such field at all, so listing keys here (matching this file's own
		// `buildHydraHeadInvitePayload` convention) is what keeps a field added to
		// `HeadPeriods` from silently slipping into the exchange.
		contestationPeriodSeconds: periods.contestationPeriodSeconds,
		depositPeriodSeconds: periods.depositPeriodSeconds,
		unsyncedPeriodSeconds: periods.unsyncedPeriodSeconds,
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
	await registerInviteOnHost(
		node.hostBaseUrl,
		node.adminToken,
		{
			nonce,
			hostNodeId: node.nodeId,
			expiresAt: expiresAt.getTime(),
		},
		{ allowInsecureHttp: node.allowInsecureHttp },
	);

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
			...sealInviteNonce(nonce),
			expiresAt,
			LocalHotWallet: { connect: { id: wallet.id } },
			HydraHost: { connect: { id: node.hostId } },
			hostNodeId: node.nodeId,
			issuerWalletAddress: wallet.walletAddress,
			issuerHydraVerificationKey: node.hydraVerificationKey,
			issuerCardanoVerificationKey: node.cardanoVerificationKey,
			issuerAdvertise: node.advertise,
			issuerExchangeUrl: exchangeUrl,
			issuerSignature: sealInviteSignature(signature.signature),
			issuerSignerKey: signature.key,
			// Explicit for the same reason as the signed payload above: `periods`
			// also carries the LOCAL-only `depositActivationSeconds`, and
			// `HydraHeadInvite` has no column for it (no migration for this field —
			// see `HeadPeriods`). A blind `...periods` here would make Prisma throw
			// "Unknown argument" the moment this ran against the real schema.
			contestationPeriodSeconds: periods.contestationPeriodSeconds,
			depositPeriodSeconds: periods.depositPeriodSeconds,
			unsyncedPeriodSeconds: periods.unsyncedPeriodSeconds,
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

type RedeemerContext = {
	wallet: WalletContext;
	issuerSignature: string;
	transport: ExchangeTransportOptions;
};

async function findRedeemerRecord(nonce: string): Promise<RedeemerRecord | null> {
	return await prisma.hydraHeadInvite.findUnique({
		where: { nonceHash: hashInviteNonce(nonce) },
		include: { LocalHotWallet: true, HydraHost: true },
	});
}

/** Carry a recorded redemption to its head, or say why it cannot go further yet. */
async function finishRedemption(
	record: RedeemerRecord,
	options: { rowIsNew: boolean; transport: ExchangeTransportOptions },
): Promise<RedeemedInvite> {
	const ports = buildRedemptionPorts({ record, transport: options.transport, createHead: createHeadFromExchange });
	const result = await advanceRedemption(toRedemptionState(record), ports, { rowIsNew: options.rowIsNew });
	logger.info(`hydra: redeemed invite ${nonceLogRef(revealInviteNonce(record))} from ${record.issuerWalletAddress}`);
	return { inviteId: record.id, hydraHeadId: result.hydraHeadId, issuerWalletAddress: record.issuerWalletAddress };
}

/**
 * An earlier attempt at this nonce is continued, not refused.
 *
 * The invite's nonce is single-use on the issuer's Host, so once an attempt may
 * have spent it the only way to finish is to carry that attempt on. This runs
 * before the freshness check on purpose: the Host answers a repeat of a
 * redemption that landed even after the invite has expired, and refusing here
 * would stop a redeemer whose answer was lost from ever learning it succeeded.
 */
async function resumeRedemption(earlier: RedeemerRecord, context: RedeemerContext): Promise<RedeemedInvite> {
	const isSameRedemption =
		earlier.role === HydraInviteRole.Redeemer &&
		earlier.localHotWalletId === context.wallet.id &&
		revealInviteSignature(earlier) === context.issuerSignature;
	if (!isSameRedemption) {
		throw createHttpError(409, 'this invite has already been redeemed here');
	}
	if (earlier.status === HydraInviteStatus.Completed && earlier.hydraHeadId !== null) {
		return { inviteId: earlier.id, hydraHeadId: earlier.hydraHeadId, issuerWalletAddress: earlier.issuerWalletAddress };
	}
	if (earlier.status === HydraInviteStatus.Failed) {
		throw createHttpError(409, 'an earlier redemption of this invite failed; ask the issuer for a new invite');
	}
	if (!LIVE_REDEEMER_STATUSES.some((status) => status === earlier.status)) {
		throw createHttpError(409, 'this invite has already been redeemed here');
	}
	return await finishRedemption(earlier, { rowIsNew: false, transport: context.transport });
}

/**
 * Accept someone's invite: reserve our node, record that we are about to send
 * our material, send it, and create the Relation and Head.
 *
 * The order matters. We provision before sending, because the material is what
 * we are sending. We record the redemption before sending, because the send
 * spends the issuer's single-use nonce and a crash after it must leave
 * something to finish from. And we create the Head only once the issuer has
 * acknowledged, because a redemption the issuer never received would leave us
 * holding a head whose counterparty does not know it exists.
 */
export async function redeemHeadInvite(input: {
	invite: DecodedInvite;
	localHotWalletId: string;
	autoFund?: boolean;
	allowInsecureExchangeHttp?: boolean;
	allowPrivateExchangeNetwork?: boolean;
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
	const exchangeTransport = {
		allowInsecureHttp: input.allowInsecureExchangeHttp === true,
		allowPrivateNetwork: input.allowPrivateExchangeNetwork === true,
	};
	const context: RedeemerContext = { wallet, issuerSignature: signature.signature, transport: exchangeTransport };

	const earlier = await findRedeemerRecord(payload.nonce);
	if (earlier !== null) {
		return await resumeRedemption(earlier, context);
	}

	const freshness = checkInviteFreshness(Number(payload.expiresAt), Date.now());
	if (!freshness.fresh) {
		throw createHttpError(409, freshness.reason);
	}
	// The issuer's periods, held to the bounds we mint with. A valid signature
	// proves who chose them, not that they are safe: the issuer may run a
	// service that never checked them, and an invite that cannot become a safe
	// head must not cost this side a node and its fuel to discover that.
	assertHeadPeriodsAllowed(wallet.network, payload);

	// Reject before reserving a node. A missing HTTP opt-in is an operator
	// decision, not a provisioning failure that should strand a port and keys.
	assertExchangeTransportAllowed(payload.exchangeUrl, exchangeTransport);
	await resolveExchangeTarget(payload.exchangeUrl, exchangeTransport);

	// The issuer signed this fingerprint. Compare it to our own reviewed
	// manifest before reserving keys and a peer port, then the reservation path
	// independently checks the local Host against the same manifest.
	const expectedLedgerParamsHash = expectedHostCapabilitiesForNetwork(wallet.network).ledgerParamsHash;
	if (payload.ledgerParamsHash === null || payload.ledgerParamsHash !== expectedLedgerParamsHash) {
		throw createHttpError(409, 'the invite ledger protocol parameters do not match this service');
	}

	const periods: HeadPeriods = periodsFromInvite(payload);
	// Asked here, where the answer still costs nothing: the nonce is spent on
	// the issuer's Host by the first post, so a pair that already has a head, or
	// another redemption under way, must be refused before it.
	await assertRelationHasNoLiveHead({
		network: wallet.network,
		localHotWalletId: wallet.id,
		counterpartyWalletAddress: payload.issuerWalletAddress,
	});
	const node = await reserveNodeForExchange(
		wallet.network,
		wallet.id,
		payload.nonce,
		periods,
		input.autoFund !== false,
	);
	if (node.ledgerParamsHash !== payload.ledgerParamsHash) {
		throw createHttpError(409, 'the selected local Hydra Host does not match the invite ledger protocol parameters');
	}
	const exchangeUrl = requireExchangeUrl(node);

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

	// Recorded before the nonce is spent. Everything signed is already in hand, so
	// whatever happens after the post (a crash, a lost answer, a Host that is
	// down) leaves a record the retry and the resume job can finish, and one that
	// shields the reservation from the abandoned-reservation sweep.
	const recorded = await createRedeemerRecord({
		network: wallet.network,
		role: HydraInviteRole.Redeemer,
		status: HydraInviteStatus.Redeemed,
		...sealInviteNonce(payload.nonce),
		expiresAt: new Date(Number(payload.expiresAt)),
		LocalHotWallet: { connect: { id: wallet.id } },
		HydraHost: { connect: { id: node.hostId } },
		hostNodeId: node.nodeId,
		issuerWalletAddress: payload.issuerWalletAddress,
		issuerHydraVerificationKey: payload.hydraVerificationKey,
		issuerCardanoVerificationKey: payload.cardanoVerificationKey,
		issuerAdvertise: payload.advertise,
		issuerExchangeUrl: payload.exchangeUrl,
		issuerSignature: sealInviteSignature(signature.signature),
		issuerSignerKey: signature.key,
		// Set when the issuer's Host acknowledges the redemption, not before.
		redeemedAt: null,
		redeemerWalletAddress: wallet.walletAddress,
		redeemerHydraVerificationKey: node.hydraVerificationKey,
		redeemerCardanoVerificationKey: node.cardanoVerificationKey,
		redeemerAdvertise: node.advertise,
		redeemerExchangeUrl: exchangeUrl,
		redeemerSignature: redemptionSignature.signature,
		redeemerSignerKey: redemptionSignature.key,
		// Explicit, not `...periods`: `periods` also carries the LOCAL-only
		// `depositActivationSeconds`, which `HydraHeadInvite` has no column for.
		contestationPeriodSeconds: periods.contestationPeriodSeconds,
		depositPeriodSeconds: periods.depositPeriodSeconds,
		unsyncedPeriodSeconds: periods.unsyncedPeriodSeconds,
		ledgerParamsHash: payload.ledgerParamsHash,
	});
	if (!recorded.created) {
		// A concurrent request recorded this nonce between our check and our write.
		const winner = await findRedeemerRecord(payload.nonce);
		if (winner === null) {
			// A unique violation that is not this nonce: the node is held by another invite.
			throw createHttpError(
				409,
				'this redemption conflicts with another one on the same node; retry the same invite code',
			);
		}
		return await resumeRedemption(winner, context);
	}

	// Funded here, unlike the issuing side: the redeemer is the one that posts
	// Init, and it can do so the moment this returns. Waiting for the scheduled
	// cycle would put a chain confirmation between redeeming and being able to
	// open the head.
	if (input.autoFund !== false) {
		void fundHydraNodeNow(node.localParticipantId, true).catch((error: unknown) => {
			logger.warn(`hydra: could not pre-fund node ${node.nodeId}: ${(error as Error).message}`);
		});
	}

	const record = await findRedeemerRecord(payload.nonce);
	if (record === null) {
		throw createHttpError(500, 'hydra: a redemption was recorded and then could not be read back');
	}
	// A concurrent retry finished or ended it in between: answer as that retry would.
	if (record.status !== HydraInviteStatus.Redeemed) {
		return await resumeRedemption(record, context);
	}
	// The version written by the create, not the one read back: a retry that
	// claimed the record in between must make this request's deletes find nothing.
	return await finishRedemption(
		{ ...record, updatedAt: recorded.updatedAt },
		{ rowIsNew: true, transport: exchangeTransport },
	);
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
	/** Passed to createBoundHydraHead: runs in the head's transaction. */
	linkInvite: (tx: Prisma.TransactionClient, hydraHeadId: string) => Promise<void>;
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

	let head: { id: string };
	try {
		head = await createBoundHydraHead({
			hydraRelationId: relation.id,
			contestationPeriod: BigInt(input.contestationPeriodSeconds),
			localParticipantId: input.localParticipantId,
			remoteParticipantId: remoteParticipant.id,
			linkInvite: input.linkInvite,
		});
	} catch (error) {
		// The participant exists only to be attached to the head this call is
		// creating, and `@@unique([hydraHeadId, walletId])` does not constrain rows
		// whose `hydraHeadId` is still null. A refused head — the counterparty
		// already has a live one on this relation is the ordinary case — therefore
		// left a participant and its verification key behind, and the poll that
		// retries the adoption left another pair every tick.
		await prisma.hydraRemoteParticipant
			.delete({ where: { id: remoteParticipant.id } })
			.then(() => prisma.hydraVerificationKey.delete({ where: { id: remoteParticipant.hydraVerificationKeyId } }))
			.catch((cleanupError: unknown) =>
				logger.warn(
					`hydra: could not roll back the remote participant for a refused head: ${
						cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
					}`,
				),
			);
		throw error;
	}

	return { hydraHeadId: head.id, hydraRelationId: relation.id };
}
