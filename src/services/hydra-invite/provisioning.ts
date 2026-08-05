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
	HydraHostRequestError,
	acknowledgeEscrowOnHost,
	fetchHostCapabilities,
	hostNodeUrls,
	provisionNodeOnHost,
} from '@/services/hydra-host/client';
import { assertHostCompatible, selectPlacementHost } from '@/services/hydra-host/placement';
import { deriveNodeCardanoVkey } from './node-keys';

export type HeadPeriods = {
	contestationPeriodSeconds: number;
	depositPeriodSeconds: number;
	unsyncedPeriodSeconds: number;
};

/**
 * The three periods a head runs on, and why they differ by network.
 *
 * They answer different questions and pull in opposite directions, so one set
 * of numbers for both networks would be wrong twice over.
 *
 * **Settle time** is how long a deposit must age before the head will take it,
 * which is exactly how long a rollback has to be ruled out before those funds
 * count on L2. It is a cost on every top-up, so it wants to be short — but on
 * mainnet the funds are real, so twenty minutes buys meaningful confidence
 * against a reorg for a wait an operator will tolerate. Ten on a testnet, where
 * a rollback costs nothing.
 *
 * **Dispute window** is the opposite: it is how long after closing either side
 * may contest a stale final state, and the only protection against a
 * counterparty closing on an outdated snapshot while your node is down. Closing
 * is not always one clean step either — a head can settle across several
 * transactions — so the window has to cover a node being unavailable for a
 * realistic outage, not just a slow block. Five days on mainnet, twelve hours on
 * a testnet. The cost of a long window is only that funds settle later; the cost
 * of a short one is a close nobody was awake to contest.
 *
 * **Out-of-sync limit** follows hydra's own rule of half the dispute window: a
 * node that has seen no block for that long stops acting on its view of the
 * chain. Deriving it keeps the two consistent, which is what hydra assumes when
 * the flag is not given.
 */
/**
 * The shortest out-of-sync limit a head may run with.
 *
 * A node that sees no block for this long stops accepting commands. Preprod
 * blocks arrive a median 13s apart, but the tail decides the floor: over 60
 * consecutive blocks the p90 gap was 55s and the widest 71s, so anything near a
 * minute is crossed by ordinary jitter. Shared with the invite input so the
 * field bound and the derived-pair check cannot drift apart.
 */
export const MIN_UNSYNCED_PERIOD_SECONDS = 120;

export function defaultPeriodsFor(network: Network): HeadPeriods {
	const isMainnet = network === Network.Mainnet;
	const contestationPeriodSeconds = isMainnet ? 5 * 24 * 3600 : 12 * 3600;
	return {
		contestationPeriodSeconds,
		depositPeriodSeconds: isMainnet ? 1200 : 600,
		unsyncedPeriodSeconds: Math.round(contestationPeriodSeconds / 2),
	};
}

/** For the callers that have no network in hand yet. */
export const DEFAULT_PERIODS: HeadPeriods = defaultPeriodsFor(Network.Preprod);

export type ReservedNode = {
	hostId: string;
	hostBaseUrl: string;
	/** Where this Host redeems invites. From the Host itself, never assumed. */
	hostExchangePort: number | null;
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
	adminToken: string;
	ledgerParamsHash: string | null;
	exchangePort: number | null;
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
		adminToken: decrypt(row.encryptedAdminToken),
		ledgerParamsHash: row.ledgerParamsHash,
		exchangePort: row.exchangePort,
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
	//
	// A Host that refuses our credential is the Host's answer, not an internal
	// fault — surfacing it as a 500 sent operators looking for a bug in this
	// service when the stored token was simply wrong for that Host.
	let capabilities;
	try {
		capabilities = await fetchHostCapabilities(host.baseUrl, host.adminToken);
	} catch (error) {
		if (error instanceof HydraHostRequestError && (error.status === 401 || error.status === 403)) {
			throw createHttpError(
				502,
				`the hydra host at ${host.baseUrl} rejected our admin key. Reconnect the node with the key that host was started with`,
			);
		}
		throw error;
	}
	assertHostCompatible(capabilities, { network: capabilities.network, ledgerParamsHash: host.ledgerParamsHash });

	const provisioned = await provisionNodeOnHost(host.baseUrl, host.adminToken, nonce, periods);
	const urls = hostNodeUrls(host.baseUrl, provisioned.nodeId);

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
		await acknowledgeEscrowOnHost(host.baseUrl, host.adminToken, provisioned.nodeId);
	}

	return {
		hostId: host.id,
		hostBaseUrl: host.baseUrl,
		// Read from the capabilities probe above when the row had none, so the
		// very first invite on a freshly connected Host is already correct.
		hostExchangePort: host.exchangePort ?? capabilities.exchangePort,
		adminToken: host.adminToken,
		nodeId: provisioned.nodeId,
		advertise: provisioned.advertise,
		hydraVerificationKey: provisioned.hydraVerificationKey,
		cardanoVerificationKey: provisioned.cardanoVerificationKey,
		ledgerParamsHash: host.ledgerParamsHash,
		localParticipantId,
	};
}
