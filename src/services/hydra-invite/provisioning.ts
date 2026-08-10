/**
 * Reserving a node for an exchange.
 *
 * Both sides of an invite need the same thing: a node with fresh keys and a
 * peer port, whose material can be signed and sent, and which cannot boot until
 * the other side's material arrives. Issuing an invite reserves one; redeeming
 * one reserves the mirror.
 *
 * The reservation is the cost of the design. A node holds a port, a key pair
 * and a persistence directory from the moment an invite is minted, and because
 * `--peer` is startup configuration it can never be re-pointed at a different
 * counterparty — so an invite that is never redeemed is a node that must be
 * reaped rather than reused.
 */

import createHttpError from 'http-errors';
import { Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { decrypt, encrypt } from '@/utils/security/encryption';
import {
	acknowledgeEscrowOnHost,
	fetchHostCapabilities,
	hostNodeUrls,
	provisionNodeOnHost,
} from '@/services/hydra-host/client';
import { assertHostCompatible, selectPlacementHost } from '@/services/hydra-host/placement';
import { expectedHostCapabilitiesForNetwork } from '@/services/hydra-host/compatibility';
import { deriveNodeCardanoVkey } from './node-keys';

export type HeadPeriods = {
	contestationPeriodSeconds: number;
	depositPeriodSeconds: number;
	unsyncedPeriodSeconds: number;
};

/** Matches what a two-party head on preprod has been run with. */
export const DEFAULT_PERIODS: HeadPeriods = {
	contestationPeriodSeconds: 220,
	depositPeriodSeconds: 300,
	unsyncedPeriodSeconds: 1800,
};

export type ReservedNode = {
	hostId: string;
	hostBaseUrl: string;
	allowInsecureHttp: boolean;
	adminToken: string;
	nodeId: string;
	advertise: string;
	hydraVerificationKey: string;
	cardanoVerificationKey: string;
	ledgerParamsHash: string | null;
	/** The participant row created for it, which the head later adopts. */
	localParticipantId: string;
};

/** The Host chosen for a network, with its admin token already decrypted. */
export async function selectHostForNetwork(network: Network): Promise<{
	id: string;
	baseUrl: string;
	allowInsecureHttp: boolean;
	adminToken: string;
}> {
	const hosts = await prisma.hydraHost.findMany({ where: { network } });
	const chosen = selectPlacementHost(
		hosts.map((row) => ({
			id: row.id,
			name: row.name,
			network: row.network,
			status: row.status,
			hasAdminToken: row.encryptedAdminToken !== null,
		})),
		network,
	);

	const row = hosts.find((candidate) => candidate.id === chosen.id);
	if (!row || row.encryptedAdminToken === null) {
		throw createHttpError(409, 'the selected hydra host has no admin token, so nothing can be provisioned on it');
	}
	return {
		id: row.id,
		baseUrl: row.baseUrl,
		allowInsecureHttp: row.allowInsecureHttp,
		adminToken: decrypt(row.encryptedAdminToken),
	};
}

/**
 * Provision a node and record its keys, ready to be named in an invite.
 *
 * The nonce doubles as the idempotency key: a retried mint reuses the same node
 * rather than stranding one, which matters more here than it did for offers
 * because an invite's whole life is spent holding this reservation.
 */
export async function reserveNodeForExchange(
	network: Network,
	localHotWalletId: string,
	nonce: string,
	periods: HeadPeriods,
): Promise<ReservedNode> {
	const host = await selectHostForNetwork(network);

	// Checked before provisioning, not at first use: a head placed on a host
	// whose ledger differs fails at commit time, far from the cause.
	const transport = { allowInsecureHttp: host.allowInsecureHttp };
	const capabilities = await fetchHostCapabilities(host.baseUrl, host.adminToken, transport);
	try {
		assertHostCompatible(capabilities, expectedHostCapabilitiesForNetwork(network));
	} catch (error) {
		throw createHttpError(409, (error as Error).message);
	}

	const provisioned = await provisionNodeOnHost(host.baseUrl, host.adminToken, nonce, periods, transport);
	const urls = hostNodeUrls(host.baseUrl, provisioned.nodeId, transport);

	// A replayed provision returns no secrets, because the Host discloses them
	// exactly once. That is not an error — it means this nonce already reserved a
	// node on a previous attempt, and its participant row already exists.
	const existing = await prisma.hydraLocalParticipant.findFirst({
		where: { hydraHostId: host.id, hostNodeId: provisioned.nodeId },
		select: { id: true },
	});

	let localParticipantId: string;
	if (existing !== null) {
		localParticipantId = existing.id;
	} else if (provisioned.secrets === null) {
		// No secrets and no prior row: the material exists only on the Host, and
		// a participant cannot be represented without it. Failing here keeps the
		// node reapable rather than recording a head we could never operate.
		throw createHttpError(
			409,
			'the hydra host disclosed no keys for this node and none are stored here; delete the node and start again',
		);
	} else {
		const secrets = provisioned.secrets;
		// Written before escrow-ack, which seals the disclosure path on the Host.
		// Our copy first is what makes the material recoverable if anything after
		// this fails.
		const participant = await prisma.hydraLocalParticipant.create({
			data: {
				Wallet: { connect: { id: localHotWalletId } },
				cardanoVkey: deriveNodeCardanoVkey(provisioned.cardanoVerificationKey),
				nodeUrl: urls.nodeUrl,
				nodeHttpUrl: urls.nodeHttpUrl,
				HydraHost: { connect: { id: host.id } },
				hostNodeId: provisioned.nodeId,
				// Both keys, not just the Hydra one: the Host discloses each exactly
				// once, so a key dropped here survives only on the Host's disk — and
				// the node's on-chain identity would go with it.
				HydraSecretKey: {
					create: {
						hydraSK: encrypt(secrets.hydraSigningKey),
						cardanoSK: encrypt(secrets.cardanoSigningKey),
					},
				},
			},
		});
		localParticipantId = participant.id;
		await acknowledgeEscrowOnHost(host.baseUrl, host.adminToken, provisioned.nodeId, transport);
	}

	return {
		hostId: host.id,
		hostBaseUrl: host.baseUrl,
		allowInsecureHttp: host.allowInsecureHttp,
		adminToken: host.adminToken,
		nodeId: provisioned.nodeId,
		advertise: provisioned.advertise,
		hydraVerificationKey: provisioned.hydraVerificationKey,
		cardanoVerificationKey: provisioned.cardanoVerificationKey,
		ledgerParamsHash: capabilities.ledgerParamsHash,
		localParticipantId,
	};
}
