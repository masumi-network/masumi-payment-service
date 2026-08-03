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
import { forgetHostInvite, removeHostNode } from '@/services/hydra-host/client';
import { decodeInviteCode } from '@/services/hydra-invite/invite-code';
import { INVITE_TTL_MS } from '@/services/hydra-invite/invite-payload';
import { mintHeadInvite, redeemHeadInvite } from '@/services/hydra-invite/orchestrator';
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
});

export const getInviteSchemaOutput = z.object({ invites: z.array(inviteSchema) });

export const queryInviteGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getInviteSchemaInput,
	output: getInviteSchemaOutput,
	handler: async ({ input }) => {
		const rows = await prisma.hydraHeadInvite.findMany({
			where: input.status === undefined ? {} : { status: input.status },
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
			"Send the node's L1 fuel from the chosen wallet straight away. On unless set false — a node cannot post Init, Commit, Close or Fanout without it, so opt out only if you fund that key yourself.",
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
	advertise: z.string(),
	exchangeUrl: z.string(),
	expiresAt: z.string(),
	contestationPeriodSeconds: z.number(),
	depositPeriodSeconds: z.number(),
	unsyncedPeriodSeconds: z.number(),
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

		return {
			nonce: decoded.payload.nonce,
			network,
			issuerWalletAddress: decoded.payload.issuerWalletAddress,
			advertise: decoded.payload.advertise,
			exchangeUrl: decoded.payload.exchangeUrl,
			expiresAt: new Date(Number(decoded.payload.expiresAt)).toISOString(),
			contestationPeriodSeconds: decoded.payload.contestationPeriodSeconds,
			depositPeriodSeconds: decoded.payload.depositPeriodSeconds,
			unsyncedPeriodSeconds: decoded.payload.unsyncedPeriodSeconds,
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
		// Host first: while it still honours the nonce, a redemption in flight
		// could start the node we are about to delete.
		await forgetHostInvite(invite.HydraHost.baseUrl, adminToken, invite.nonce);
		await removeHostNode(invite.HydraHost.baseUrl, adminToken, invite.hostNodeId, { force: false });

		await prisma.hydraLocalParticipant.deleteMany({
			where: { hydraHostId: invite.hydraHostId, hostNodeId: invite.hostNodeId, hydraHeadId: null },
		});
		const updated = await prisma.hydraHeadInvite.update({
			where: { id: invite.id },
			data: { status: HydraInviteStatus.Revoked },
		});
		logger.info(`hydra: revoked invite ${invite.nonce}`);
		return { id: updated.id, status: updated.status };
	},
});
