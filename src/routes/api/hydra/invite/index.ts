/**
 * Head invites: the operator-facing half of the exchange (ADR 0011).
 *
 * Every endpoint here is admin and outbound-only. The counterparty-facing half
 * lives on the Hydra Host's Exchange Plane, which is why this service needs no
 * inbound reachability — the wire offer endpoints that did are gone.
 *
 * The asymmetry to keep in mind while reading: issuing an invite spends
 * resources (a node and a peer port) and redeeming one spends them again on the
 * mirror. Neither is free, and neither can be undone by re-pointing — `--peer`
 * is startup configuration — so both are deliberate operator actions rather
 * than anything automatic.
 */

import createHttpError from 'http-errors';
import { z } from '@masumi/payment-core/zod';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraInviteRole, HydraInviteStatus, Network } from '@/generated/prisma/client';
import { decrypt } from '@/utils/security/encryption';
import {
	fetchHostRedemptions,
	forgetHostInvite,
	HydraHostRequestError,
	removeHostNode,
} from '@/services/hydra-host/client';
import { MIN_UNSYNCED_PERIOD_SECONDS } from '@/services/hydra-invite/provisioning';
import { decodeInviteCode } from '@/services/hydra-invite/invite-code';
import { INVITE_TTL_MS } from '@/services/hydra-invite/invite-payload';
import { releaseReservedParticipants } from '@/services/hydra-invite/release-reservation';
import { mintHeadInvite, redeemHeadInvite } from '@/services/hydra-invite/orchestrator';
import { inspectExchangeNetwork } from '@/services/hydra-invite/exchange-client';
import {
	registryPolicyIdFor,
	resolveCounterpartyIdentity,
	type CounterpartyIdentity,
} from '@/services/hydra-invite/counterparty-identity';

/**
 * Registry identity for the wallet that signed an invite.
 *
 * Needs a Blockfrost key, which belongs to a payment source rather than to the
 * invite — so the source for that network is asked. An operator with no
 * configured source still gets the rest of the preview, with the lookup failure
 * stated rather than shown as "no entries".
 */
async function resolveIssuerIdentity(walletAddress: string, network: Network): Promise<CounterpartyIdentity> {
	const source = await prisma.paymentSource.findFirst({
		where: { network, deletedAt: null },
		include: { PaymentSourceConfig: true },
	});
	if (!source) {
		return {
			walletAddress,
			policyId: registryPolicyIdFor(network),
			entries: [],
			lookupError: `no payment source is configured for ${network}, so the chain cannot be consulted`,
		};
	}
	// Read raw: rpcProviderApiKey is stored in plaintext, as every other consumer
	// treats it (see the getBlockfrostInstance callers). Decrypting it here fails
	// with ERR_CRYPTO_INVALID_IV rather than with anything self-explanatory.
	return await resolveCounterpartyIdentity(walletAddress, network, source.PaymentSourceConfig.rpcProviderApiKey);
}

const inviteSchema = z.object({
	id: z.string(),
	nonce: z.string(),
	network: z.nativeEnum(Network),
	role: z.nativeEnum(HydraInviteRole),
	status: z.nativeEnum(HydraInviteStatus),
	createdAt: z.string(),
	expiresAt: z.string(),
	hydraHostId: z.string(),
	hostNodeId: z.string(),
	issuerWalletAddress: z.string(),
	issuerExchangeUrl: z.string(),
	redeemedAt: z.string().nullable(),
	redeemerWalletAddress: z.string().nullable(),
	hydraHeadId: z.string().nullable(),
});

type InviteRow = {
	id: string;
	nonce: string;
	network: Network;
	role: HydraInviteRole;
	status: HydraInviteStatus;
	createdAt: Date;
	expiresAt: Date;
	hydraHostId: string;
	hostNodeId: string;
	issuerWalletAddress: string;
	issuerExchangeUrl: string;
	redeemedAt: Date | null;
	redeemerWalletAddress: string | null;
	hydraHeadId: string | null;
};

function toPublicInvite(row: InviteRow) {
	return {
		id: row.id,
		nonce: row.nonce,
		network: row.network,
		role: row.role,
		status: row.status,
		createdAt: row.createdAt.toISOString(),
		expiresAt: row.expiresAt.toISOString(),
		hydraHostId: row.hydraHostId,
		hostNodeId: row.hostNodeId,
		issuerWalletAddress: row.issuerWalletAddress,
		issuerExchangeUrl: row.issuerExchangeUrl,
		redeemedAt: row.redeemedAt?.toISOString() ?? null,
		redeemerWalletAddress: row.redeemerWalletAddress,
		hydraHeadId: row.hydraHeadId,
	};
}

// --- GET: list invites ---

export const getInviteSchemaInput = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(25),
	status: z.nativeEnum(HydraInviteStatus).optional(),
	/** Same scoping as the head list: an invite becomes a head on one network. */
	network: z.nativeEnum(Network).optional().describe('Filter by Cardano network'),
});

export const getInviteSchemaOutput = z.object({ invites: z.array(inviteSchema) });

export const queryInviteGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getInviteSchemaInput,
	output: getInviteSchemaOutput,
	handler: async ({ input }) => {
		const rows = await prisma.hydraHeadInvite.findMany({
			where: {
				...(input.status === undefined ? {} : { status: input.status }),
				...(input.network === undefined ? {} : { network: input.network }),
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
		});
		return { invites: rows.map(toPublicInvite) };
	},
});

// --- POST: mint an invite ---

export const createInviteSchemaInput = z.object({
	hotWalletId: z.string().min(1).describe('Wallet that will identify us on the resulting head'),
	ttlHours: z.coerce
		.number()
		.int()
		.min(1)
		.max(720)
		.optional()
		.describe('How long the invite may sit before its reservation is released. Defaults to 168 (7 days).'),
	autoFund: z
		.boolean()
		.default(true)
		.describe(
			"Send the node's L1 fuel from the chosen wallet straight away. On unless set false, since a node cannot post Init, Commit, Close or Fanout without it. Opt out only if you fund that key yourself.",
		),
	depositPeriodSeconds: z.coerce
		.number()
		.int()
		// Five minutes. A node measures a deposit's age in its OWN chain time, and
		// the window in which it will take one is a single period wide: from
		// deposit + period to deposit + three periods.
		//
		// The old floor of two minutes assumed a chain view about half a minute
		// behind. A Blockfrost-backed node on preprod was measured 140 to 360
		// seconds behind, so by the time its clock reached deposit + 120s, real
		// time was often already past the deadline: every deposit expired without
		// the node ever considering it. Five minutes keeps the window wider than
		// the lag that closes it.
		.min(300)
		.max(86_400)
		.optional()
		.describe(
			'How long a deposit must settle before this head will take it. Both nodes run the value signed here. A top-up is unusable for one period and cannot be recovered for three. Defaults to 600 on preprod and 1200 on mainnet: on mainnet the funds are real, so the wait is what rules out a rollback before they count on L2.',
		),
	contestationPeriodSeconds: z.coerce
		.number()
		.int()
		// Five minutes. This is also the wait between closing a head and being able
		// to settle it, so it is the number an operator feels.
		//
		// The binding constraint is not disputes but the out-of-sync limit: hydra
		// derives that as half this window, and a node seeing no block for that
		// long stops accepting commands. Preprod blocks arrive a median 13s apart
		// with a widest measured gap of 71s, so the limit has to clear that tail.
		// Five minutes gives 150s. The arithmetic floor is 240s, which yields
		// exactly the 120s limit and no room; the extra minute buys margin on the
		// side where being wrong means a head that flaps out of sync and refuses
		// commands for what looks like a fault.
		.min(300)
		// Two weeks. Long windows are the safe direction — a head can settle over
		// several transactions, and the window has to cover a node being down for
		// a real outage rather than a slow block.
		.max(1_209_600)
		.optional()
		.describe(
			'How long after closing the head anyone may dispute the final state. Nobody can settle on chain until it elapses, so it is also the wait between closing a head and getting the funds back. Longer is the safe direction: it is the only protection against a counterparty closing on a stale state while your node is down, and settling can take several transactions. Defaults to 5 days on mainnet and 12 hours on preprod.',
		),
	unsyncedPeriodSeconds: z.coerce
		.number()
		.int()
		// Above the widest block gap actually seen on preprod (71s over 60
		// consecutive blocks), so ordinary jitter cannot trip it. Shared with the
		// derived-pair check so the two cannot drift apart.
		.min(MIN_UNSYNCED_PERIOD_SECONDS)
		.max(604_800)
		.optional()
		.describe(
			'How long a node may see no new block before it declares itself out of sync and refuses commands, rather than acting on a stale view of the chain. Defaults to 30 minutes on both networks, or half the dispute window where that is tighter. Half the window is the ceiling and may not be exceeded, which is checked against the resolved pair when the invite is minted rather than here, since either field may be defaulted. Raising it buys availability with the time a node needs to contest a close.',
		),
});

export const createInviteSchemaOutput = z.object({
	id: z.string(),
	nonce: z.string(),
	expiresAt: z.string(),
	code: z.string().describe('The invite itself. Hand this to the counterparty out of band.'),
});

export const createInvitePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createInviteSchemaInput,
	output: createInviteSchemaOutput,
	handler: async ({ input }) => {
		const minted = await mintHeadInvite({
			localHotWalletId: input.hotWalletId,
			autoFund: input.autoFund,
			depositPeriodSeconds: input.depositPeriodSeconds,
			contestationPeriodSeconds: input.contestationPeriodSeconds,
			unsyncedPeriodSeconds: input.unsyncedPeriodSeconds,
			ttlMs: input.ttlHours === undefined ? INVITE_TTL_MS : input.ttlHours * 60 * 60 * 1000,
		});
		logger.info(`hydra: minted invite ${minted.nonce}`);
		return {
			id: minted.inviteId,
			nonce: minted.nonce,
			expiresAt: minted.expiresAt.toISOString(),
			code: minted.code,
		};
	},
});

// --- POST: inspect an invite before committing to it ---

export const previewInviteSchemaInput = z.object({
	code: z.string().min(1).describe('An invite code received from a counterparty'),
});

export const previewInviteSchemaOutput = z.object({
	nonce: z.string(),
	network: z.nativeEnum(Network),
	issuerWalletAddress: z.string(),
	/**
	 * Which side the issuer takes, so the redeemer can be offered the wallets
	 * that can actually work. Optional: an invite minted before the role was
	 * signed carries no answer, and guessing one would filter the list wrongly.
	 */
	issuerWalletRole: z.enum(['Buyer', 'Seller']).optional(),
	advertise: z.string(),
	exchangeUrl: z.string(),
	expiresAt: z.string(),
	contestationPeriodSeconds: z.number(),
	depositPeriodSeconds: z.number(),
	unsyncedPeriodSeconds: z.number(),
	exchangeUsesPrivateNetwork: z.boolean().nullable(),
	exchangeNetworkWarning: z.string().nullable(),
	signatureValid: z.boolean(),
	alreadyKnown: z.boolean(),
	identity: z
		.object({
			policyId: z.string(),
			entries: z.array(z.object({ unit: z.string(), assetName: z.string(), name: z.string().nullable() })),
			lookupError: z.string().nullable(),
		})
		.describe('Registry entries held by the issuing wallet, so an operator can recognise who this is'),
});

/**
 * An invite's expiry, as a date, or a refusal naming what is wrong with it.
 *
 * The decoder types this field as a string and nothing more, so a code carrying
 * `"soon"` — or a number past the range of a Date — reached `toISOString()` and
 * threw a `RangeError`. Preview is the endpoint an operator uses to find out
 * whether a pasted code is any good, so answering "internal error" is the one
 * answer it must not give.
 */
function previewExpiryIso(rawExpiresAt: string): string {
	const expiresAtMs = Number(rawExpiresAt);
	if (!Number.isFinite(expiresAtMs)) {
		throw createHttpError(400, 'this invite code carries an expiry that is not a time, so it cannot be redeemed');
	}
	const expiresAt = new Date(expiresAtMs);
	if (Number.isNaN(expiresAt.getTime())) {
		throw createHttpError(400, 'this invite code carries an expiry outside the representable range');
	}
	return expiresAt.toISOString();
}

/**
 * Decode and verify an invite without acting on it.
 *
 * Separate from redemption on purpose: redeeming provisions a node and tells a
 * counterparty we are ready, and an operator should see who they are dealing
 * with — wallet, registry identity, terms — before any of that happens.
 */
export const previewInvitePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: previewInviteSchemaInput,
	output: previewInviteSchemaOutput,
	handler: async ({ input }) => {
		const decoded = decodeInviteCode(input.code);
		const { verifyHydraHeadInvite } = await import('@/services/hydra-invite/invite-signing');

		let signatureValid = true;
		try {
			await verifyHydraHeadInvite(decoded.payload, decoded.signature);
		} catch {
			// Reported rather than thrown: an operator staring at a forged invite
			// is better served by "this signature does not match" than by a 400.
			signatureValid = false;
		}

		const existing = await prisma.hydraHeadInvite.findUnique({ where: { nonce: decoded.payload.nonce } });
		const network = decoded.payload.network as Network;
		const identity = await resolveIssuerIdentity(decoded.payload.issuerWalletAddress, network);
		let exchangeUsesPrivateNetwork: boolean | null = null;
		let exchangeNetworkWarning: string | null = null;
		try {
			exchangeUsesPrivateNetwork = (await inspectExchangeNetwork(decoded.payload.exchangeUrl)).usesPrivateNetwork;
		} catch (error) {
			exchangeNetworkWarning = (error as Error).message;
		}

		return {
			nonce: decoded.payload.nonce,
			network,
			issuerWalletAddress: decoded.payload.issuerWalletAddress,
			issuerWalletRole: decoded.payload.issuerWalletRole,
			advertise: decoded.payload.advertise,
			exchangeUrl: decoded.payload.exchangeUrl,
			// The redeem path rejects a non-numeric expiry; preview only reads it, so
			// it reported one as a 500 — from the endpoint whose whole job is to tell
			// an operator whether a pasted code is good.
			expiresAt: previewExpiryIso(decoded.payload.expiresAt),
			contestationPeriodSeconds: decoded.payload.contestationPeriodSeconds,
			depositPeriodSeconds: decoded.payload.depositPeriodSeconds,
			unsyncedPeriodSeconds: decoded.payload.unsyncedPeriodSeconds,
			exchangeUsesPrivateNetwork,
			exchangeNetworkWarning,
			signatureValid,
			alreadyKnown: existing !== null,
			identity,
		};
	},
});

// --- POST: redeem an invite ---

export const redeemInviteSchemaInput = z.object({
	code: z.string().min(1),
	hotWalletId: z.string().min(1).describe('Wallet that will identify us on the resulting head'),
	autoFund: z
		.boolean()
		.default(true)
		.describe("Send the node's L1 fuel from the chosen wallet straight away. On unless set false."),
	allowInsecureExchangeHttp: z
		.boolean()
		.default(false)
		.describe('Explicitly allow redemption over HTTP when a separately secured network protects the exchange'),
	allowPrivateExchangeNetwork: z
		.boolean()
		.default(false)
		.describe('Explicitly allow redemption to private, loopback, link-local, or other special-use IP space'),
});

export const redeemInviteSchemaOutput = z.object({
	id: z.string(),
	hydraHeadId: z.string(),
	counterpartyWalletAddress: z.string(),
});

export const redeemInvitePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: redeemInviteSchemaInput,
	output: redeemInviteSchemaOutput,
	handler: async ({ input }) => {
		const redeemed = await redeemHeadInvite({
			invite: decodeInviteCode(input.code),
			localHotWalletId: input.hotWalletId,
			autoFund: input.autoFund,
			allowInsecureExchangeHttp: input.allowInsecureExchangeHttp,
			allowPrivateExchangeNetwork: input.allowPrivateExchangeNetwork,
		});
		return {
			id: redeemed.inviteId,
			hydraHeadId: redeemed.hydraHeadId,
			counterpartyWalletAddress: redeemed.issuerWalletAddress,
		};
	},
});

// --- DELETE: revoke an unredeemed invite ---

export const deleteInviteSchemaInput = z.object({ id: z.string().min(1) });
export const deleteInviteSchemaOutput = z.object({ id: z.string(), status: z.nativeEnum(HydraInviteStatus) });

/**
 * Withdraw an invite nobody has redeemed, releasing its node and peer port.
 *
 * Refused once redeemed, because by then the reservation is a running node with
 * a peer: taking that away is closing a head, which has its own path and its own
 * on-chain consequences.
 */
export const deleteInviteDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteInviteSchemaInput,
	output: deleteInviteSchemaOutput,
	handler: async ({ input }) => {
		const invite = await prisma.hydraHeadInvite.findUnique({
			where: { id: input.id },
			include: { HydraHost: true },
		});
		if (!invite) {
			throw createHttpError(404, 'invite not found');
		}
		if (invite.role !== HydraInviteRole.Issuer) {
			throw createHttpError(409, 'only an invite we issued can be revoked');
		}
		if (invite.status !== HydraInviteStatus.Issued) {
			throw createHttpError(409, `this invite is ${invite.status.toLowerCase()} and can no longer be revoked`);
		}
		if (invite.HydraHost.encryptedAdminToken === null) {
			throw createHttpError(409, 'the host holding this reservation has no admin token');
		}

		const adminToken = decrypt(invite.HydraHost.encryptedAdminToken);
		const transport = { allowInsecureHttp: invite.HydraHost.allowInsecureHttp };

		// Asked before anything is destroyed, the same question the expiry sweep
		// asks. The Host accepts a redemption up to the deadline and the poller
		// that adopts it runs on its own schedule, so an invite that still reads
		// `Issued` here may already have been taken. `forgetHostInvite` destroys
		// the only copy of the counterparty's signed redemption there is: the
		// revoke would then fail anyway at `removeHostNode` — the Host refuses to
		// remove a node it has set peers on — and leave them with a live head
		// whose peer can never join and us with nothing to reconstruct it from.
		const held = await fetchHostRedemptions(invite.HydraHost.baseUrl, adminToken, 0, transport);
		if (held.invites.some((record) => record.nonce === invite.nonce && record.redeemedAt !== null)) {
			throw createHttpError(
				409,
				'this invite has already been redeemed by the counterparty; it becomes a head within seconds and can be closed from there, but it can no longer be revoked',
			);
		}

		// Host first: while it still honours the nonce, a redemption in flight
		// could start the node we are about to delete.
		await forgetHostInvite(invite.HydraHost.baseUrl, adminToken, invite.nonce, transport);
		try {
			await removeHostNode(invite.HydraHost.baseUrl, adminToken, invite.hostNodeId, {
				force: false,
				...transport,
			});
		} catch (error) {
			// A node the Host no longer has is the outcome this asks for — the same
			// tolerance the reaper and the adoption discard already have. Without it
			// a revoke that failed after the removal could never be retried: the
			// second attempt 404s on a node the first one already took, the local
			// invite is never marked Revoked, and its participant stays held until
			// the invite expires on its own.
			if (!(error instanceof HydraHostRequestError && error.status === 404)) throw error;
		}

		// Revoked first, released second. Releasing sweeps the node's fuel back to
		// the wallet that supplied it, and that sweep refuses while the invite is
		// still live — the node would need those funds to post an Init. Called the
		// other way round it kept both the participant and its ADA.
		//
		// Conditional on the status this request checked, not on the id alone. Two
		// Host round trips happen between that check and this write, and the
		// redemption poller runs every ten seconds: it can carry the invite all the
		// way to a head in that gap, and an unconditional write would then stamp
		// `Revoked` over a redemption that produced a live head — leaving the head
		// running under an invite that reads as revoked, and its node no longer
		// counted as held.
		const revoked = await prisma.hydraHeadInvite.updateMany({
			where: { id: invite.id, status: HydraInviteStatus.Issued },
			data: { status: HydraInviteStatus.Revoked },
		});
		if (revoked.count !== 1) {
			const current = await prisma.hydraHeadInvite.findUniqueOrThrow({ where: { id: invite.id } });
			throw createHttpError(
				409,
				`this invite was ${current.status.toLowerCase()} while the revoke was in progress, so it was not revoked`,
			);
		}
		const updated = await prisma.hydraHeadInvite.findUniqueOrThrow({ where: { id: invite.id } });
		const release = await releaseReservedParticipants({
			hydraHostId: invite.hydraHostId,
			hostNodeId: invite.hostNodeId,
		});
		if (release.retained > 0) {
			logger.warn(
				`hydra: invite ${invite.nonce} was revoked but ${release.retained} node reservation(s) still hold funds; ` +
					'they are kept until a later sweep settles them',
			);
		}
		logger.info(`hydra: revoked invite ${invite.nonce}`);
		return { id: updated.id, status: updated.status };
	},
});
