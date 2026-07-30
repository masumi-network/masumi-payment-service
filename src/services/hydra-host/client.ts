/**
 * Client for a Hydra Host control plane.
 *
 * Two tiers, deliberately separate call paths: the admin token provisions and
 * reconfigures nodes, the user token is what the node client later uses at
 * runtime. A Host may be registered with only a user token, in which case this
 * service can operate existing nodes but cannot provision new ones.
 */

import { createHash } from 'node:crypto';
import { HydraProtocolError } from '@/lib/hydra/hydra/errors';
import { hydraAuthHeaders } from '@/lib/hydra/hydra/auth';
import { getOwnString, getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';

const DEFAULT_TIMEOUT_MS = 15_000;

export class HydraHostRequestError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
		this.name = 'HydraHostRequestError';
	}
}

export type HostCapabilities = {
	hydraVersion: string;
	scriptCatalogueHash: string | null;
	ledgerParamsHash: string | null;
	network: string;
	nodeSlots: { used: number; capacity: number };
	probeError: string | null;
};

export type ProvisionedNode = {
	nodeId: string;
	advertise: string;
	peerPort: number;
	hydraVerificationKey: string;
	cardanoVerificationKey: string;
	/** Present only in the provisioning response, before escrow-ack. */
	secrets: { hydraSigningKey: string; cardanoSigningKey: string } | null;
};

export type HostPeer = {
	advertise: string;
	hydraVerificationKey: string;
	cardanoVerificationKey: string;
};

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function request(
	baseUrl: string,
	path: string,
	token: string,
	init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<unknown> {
	// Built before the try: a malformed stored token throws here, and wrapping it
	// below would report a credential problem as an unreachable host.
	const headers = {
		'Content-Type': 'application/json',
		...hydraAuthHeaders(token),
		...(init.idempotencyKey === undefined ? {} : { 'Idempotency-Key': init.idempotencyKey }),
	};

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
	try {
		const response = await fetch(joinUrl(baseUrl, path), {
			method: init.method ?? 'GET',
			headers,
			redirect: 'error',
			signal: controller.signal,
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		});

		const text = await response.text();
		const parsed: unknown = text.length === 0 ? null : safeParse(text);

		if (!response.ok) {
			const detail = isPlainObject(parsed) ? (getOwnString(parsed, 'error') ?? text) : text;
			throw new HydraHostRequestError(
				`${init.method ?? 'GET'} ${path} on the hydra host failed (${response.status}): ${detail}`,
				response.status,
			);
		}
		return parsed;
	} catch (error) {
		if (error instanceof HydraHostRequestError) {
			throw error;
		}
		// Never let the credential surface in a transport error message.
		throw new HydraHostRequestError(`could not reach the hydra host at ${baseUrl}: ${(error as Error).message}`, null);
	} finally {
		clearTimeout(timer);
	}
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function requireString(value: unknown, field: string): string {
	if (!isPlainObject(value)) {
		throw new HydraProtocolError(`hydra host response is not an object (reading ${field})`);
	}
	const found = getOwnString(value, field);
	if (found === undefined) {
		throw new HydraProtocolError(`hydra host response is missing ${field}`);
	}
	return found;
}

export async function fetchHostCapabilities(baseUrl: string, adminToken: string): Promise<HostCapabilities> {
	const body = await request(baseUrl, '/v1/capabilities', adminToken);
	if (!isPlainObject(body)) {
		throw new HydraProtocolError('hydra host returned a malformed capabilities response');
	}
	const slots = getOwnValue(body, 'nodeSlots');
	const used = isPlainObject(slots) ? getOwnValue(slots, 'used') : undefined;
	const capacity = isPlainObject(slots) ? getOwnValue(slots, 'capacity') : undefined;

	return {
		hydraVersion: getOwnString(body, 'hydraVersion') ?? '',
		scriptCatalogueHash: hashOf(getOwnValue(body, 'scriptCatalogue')),
		ledgerParamsHash: getOwnString(body, 'ledgerParamsHash') ?? null,
		network: getOwnString(body, 'network') ?? '',
		nodeSlots: {
			used: typeof used === 'number' ? used : 0,
			capacity: typeof capacity === 'number' ? capacity : 0,
		},
		probeError: getOwnString(body, 'probeError') ?? null,
	};
}

/**
 * Stable fingerprint of the script catalogue.
 *
 * Genuinely hashed rather than stored verbatim: the catalogue is a nested
 * document of unbounded size, and the column is named for a hash. Comparison
 * stays exact either way, but the stored value stays small and the name stops
 * lying.
 */
function hashOf(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	const canonical = typeof value === 'string' ? value : JSON.stringify(value);
	return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export async function provisionNodeOnHost(
	baseUrl: string,
	adminToken: string,
	idempotencyKey: string,
	options: { contestationPeriodSeconds?: number; depositPeriodSeconds?: number; unsyncedPeriodSeconds?: number } = {},
): Promise<ProvisionedNode> {
	const body = await request(baseUrl, '/v1/nodes', adminToken, {
		method: 'POST',
		idempotencyKey,
		body: options,
	});
	if (!isPlainObject(body)) {
		throw new HydraProtocolError('hydra host returned a malformed provisioning response');
	}

	const secretsValue = getOwnValue(body, 'secrets');
	const secrets = isPlainObject(secretsValue)
		? {
				hydraSigningKey: requireString(secretsValue, 'hydraSigningKey'),
				cardanoSigningKey: requireString(secretsValue, 'cardanoSigningKey'),
			}
		: null;

	const peerPort = getOwnValue(body, 'peerPort');
	return {
		nodeId: requireString(body, 'nodeId'),
		advertise: requireString(body, 'advertise'),
		peerPort: typeof peerPort === 'number' ? peerPort : 0,
		hydraVerificationKey: requireString(body, 'hydraVerificationKey'),
		cardanoVerificationKey: requireString(body, 'cardanoVerificationKey'),
		secrets,
	};
}

/** Seal the disclosure path and hand the node to the Host's supervisor. */
export async function acknowledgeEscrowOnHost(baseUrl: string, adminToken: string, nodeId: string): Promise<void> {
	await request(baseUrl, `/v1/nodes/${nodeId}/escrow-ack`, adminToken, { method: 'POST' });
}

export async function setHostNodePeers(
	baseUrl: string,
	adminToken: string,
	nodeId: string,
	peers: HostPeer[],
): Promise<void> {
	await request(baseUrl, `/v1/nodes/${nodeId}`, adminToken, { method: 'PATCH', body: { peers } });
}

export async function removeHostNode(
	baseUrl: string,
	adminToken: string,
	nodeId: string,
	options: { force: boolean },
): Promise<void> {
	const query = options.force ? '?force=true' : '';
	await request(baseUrl, `/v1/nodes/${nodeId}${query}`, adminToken, { method: 'DELETE' });
}

/**
 * URLs the payment service uses to reach a provisioned node.
 *
 * These deliberately land on the Host's proxy rather than the node itself: the
 * node binds loopback and has no authentication, so the proxy is the only route
 * to it. The shape also satisfies the existing client — `buildHydraHttpEndpoint`
 * appends `/protocol-parameters` and `withHistorySetting` appends `?history=`,
 * both of which the proxy allows.
 */
export function hostNodeUrls(baseUrl: string, nodeId: string): { nodeUrl: string; nodeHttpUrl: string } {
	const httpUrl = joinUrl(baseUrl, `/v1/nodes/${nodeId}/api`);
	return {
		nodeHttpUrl: httpUrl,
		nodeUrl: httpUrl.replace(/^http/, 'ws'),
	};
}

/** Public material one side contributes to a head. */
export type ExchangeMaterial = {
	walletAddress: string;
	hydraVerificationKey: string;
	cardanoVerificationKey: string;
	advertise: string;
	exchangeUrl: string;
};

export type HostInviteRecord = {
	nonce: string;
	hostNodeId: string;
	expiresAt: number;
	redeemedAt: number | null;
	redeemer: ExchangeMaterial | null;
	redeemerSignature: { signature: string; key: string } | null;
	startError: string | null;
};

/**
 * Tell a Host to honour an invite we just minted.
 *
 * The Host is given only the nonce, the reserved node and an expiry — never the
 * signed payload. It cannot verify a signature and has no use for one; keeping
 * the material out of it means a Host compromise leaks nothing about who we are
 * negotiating with beyond what the peer plane already reveals.
 */
export async function registerInviteOnHost(
	baseUrl: string,
	adminToken: string,
	invite: { nonce: string; hostNodeId: string; expiresAt: number },
): Promise<void> {
	await request(baseUrl, '/v1/invites', adminToken, { method: 'POST', body: invite });
}

/** Redemptions since the watermark. One request however many invites are outstanding. */
export async function fetchHostRedemptions(
	baseUrl: string,
	adminToken: string,
	redeemedSince: number,
): Promise<{ invites: HostInviteRecord[]; now: number }> {
	const body = await request(baseUrl, `/v1/invites?redeemedSince=${redeemedSince}`, adminToken);
	if (!isPlainObject(body)) {
		throw new HydraProtocolError('hydra host returned a malformed invite list');
	}
	const invites = getOwnValue(body, 'invites');
	const now = getOwnValue(body, 'now');
	return {
		invites: Array.isArray(invites) ? (invites as HostInviteRecord[]) : [],
		now: typeof now === 'number' ? now : Date.now(),
	};
}

/** Invites counterparties have left for the operator to consider. */
export type HostInboundInvite = {
	nonce: string;
	payload: string;
	signature: { signature: string; key: string };
	issuerWalletAddress: string;
	receivedAt: number;
};

export async function fetchHostInboundInvites(baseUrl: string, adminToken: string): Promise<HostInboundInvite[]> {
	const body = await request(baseUrl, '/v1/inbound-invites', adminToken);
	if (!isPlainObject(body)) {
		throw new HydraProtocolError('hydra host returned a malformed inbound invite list');
	}
	const inbound = getOwnValue(body, 'inbound');
	return Array.isArray(inbound) ? (inbound as HostInboundInvite[]) : [];
}

export async function forgetHostInboundInvite(baseUrl: string, adminToken: string, nonce: string): Promise<void> {
	await request(baseUrl, `/v1/inbound-invites/${nonce}`, adminToken, { method: 'DELETE' });
}

export async function forgetHostInvite(baseUrl: string, adminToken: string, nonce: string): Promise<void> {
	await request(baseUrl, `/v1/invites/${nonce}`, adminToken, { method: 'DELETE' });
}

/**
 * Replace the set of wallets whose POSTed invites this Host accepts.
 *
 * Sent whole rather than incrementally: a Host that missed one add would
 * silently refuse a legitimate counterparty, and the list is small enough that
 * resending it is cheaper than reconciling it.
 */
export async function setHostAllowedIssuers(
	baseUrl: string,
	adminToken: string,
	allowedIssuers: string[],
): Promise<void> {
	await request(baseUrl, '/v1/allowed-issuers', adminToken, { method: 'PUT', body: { allowedIssuers } });
}
