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
import { validateHydraHttpUrl } from '@/lib/hydra/hydra/node-url';
import { readBoundedHttpResponse } from '@/lib/hydra/hydra/node-http-response';
import { getOwnString, getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';
import { logger } from '@masumi/payment-core/logger';
import { z } from '@masumi/payment-core/zod';
import { nonceLogRef } from '@/services/hydra-invite/nonce-log-ref';
import { normalizeReleaseInfo, type ReleaseInfo } from '@/services/release/release-info';
import { fetchHydraHost } from './transport';

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
	/** Where this Host serves its Exchange Plane. Null on a Host that predates reporting it. */
	exchangePort: number | null;
	/** Public, TLS-backed Exchange Plane URL. */
	exchangeUrl: string | null;
	nodeSlots: { used: number; capacity: number };
	probeError: string | null;
	/** Project release of the Host image. Both null on a Host that predates reporting it. */
	release: ReleaseInfo;
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

export type HostTransportOptions = {
	allowInsecureHttp: boolean;
};

function joinUrl(baseUrl: string, path: string, transport: HostTransportOptions): string {
	const parsed = new URL(baseUrl);
	if (parsed.protocol === 'http:' && !transport.allowInsecureHttp) {
		throw new Error('Hydra Host URL uses HTTP without the explicit allowInsecureHttp opt-in');
	}
	const validatedBaseUrl = validateHydraHttpUrl(baseUrl, {
		plaintextHosts: parsed.protocol === 'http:' ? [parsed.hostname] : [],
	});
	return `${validatedBaseUrl}${path}`;
}

async function request(
	baseUrl: string,
	path: string,
	token: string,
	transport: HostTransportOptions,
	init: { method?: string; body?: unknown; idempotencyKey?: string; logPath?: string } = {},
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
		const response = await fetchHydraHost(joinUrl(baseUrl, path, transport), {
			method: init.method ?? 'GET',
			headers,
			signal: controller.signal,
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		});

		// Bounded while streaming, error bodies included: a registered Host is
		// still a remote party, and an unbounded body read is a memory DoS.
		const text = await readBoundedHttpResponse(response);
		const parsed: unknown = text.length === 0 ? null : safeParse(text);

		if (!response.ok) {
			// Only the `error` a Host reports, which is what an operator acts on (a
			// full Host, a refused peer). Anything else at this address is not the
			// Host's to say: a registered address can be a service that was never a
			// Host, and its reply would be shown to whoever asked. Truncated, because
			// callers log this message on every poll.
			const reported = isPlainObject(parsed) ? getOwnString(parsed, 'error') : undefined;
			const detail = reported === undefined ? '' : `: ${truncateError(reported)}`;
			throw new HydraHostRequestError(
				`${init.method ?? 'GET'} ${init.logPath ?? path} on the hydra host failed (${response.status})${detail}`,
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

/** Truncate for storage or a log line, marking that it was cut so it does not read as complete. */
export function truncateError(message: string, limit = 500): string {
	return message.length <= limit ? message : `${message.slice(0, limit - 1)}\u2026`;
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

function validatedPublicExchangeUrl(value: string | undefined): string | null {
	if (value === undefined) {
		return null;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
	const hasAllowedTransport = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback);
	if (
		!hasAllowedTransport ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0 ||
		parsed.pathname.replace(/\/+$/, '') !== '/exchange'
	) {
		return null;
	}
	return value;
}

export async function fetchHostCapabilities(
	baseUrl: string,
	adminToken: string,
	transport: HostTransportOptions,
): Promise<HostCapabilities> {
	const body = await request(baseUrl, '/v1/capabilities', adminToken, transport);
	if (!isPlainObject(body)) {
		throw new HydraProtocolError('hydra host returned a malformed capabilities response');
	}
	const slots = getOwnValue(body, 'nodeSlots');
	const used = isPlainObject(slots) ? getOwnValue(slots, 'used') : undefined;
	const capacity = isPlainObject(slots) ? getOwnValue(slots, 'capacity') : undefined;
	const release = getOwnValue(body, 'release');

	return {
		hydraVersion: getOwnString(body, 'hydraVersion') ?? '',
		scriptCatalogueHash: hashOf(getOwnValue(body, 'scriptCatalogue')),
		ledgerParamsHash: getOwnString(body, 'ledgerParamsHash') ?? null,
		network: getOwnString(body, 'network') ?? '',
		exchangePort:
			typeof getOwnValue(body, 'exchangePort') === 'number' ? (getOwnValue(body, 'exchangePort') as number) : null,
		exchangeUrl: validatedPublicExchangeUrl(getOwnString(body, 'exchangeUrl')),
		nodeSlots: {
			used: typeof used === 'number' ? used : 0,
			capacity: typeof capacity === 'number' ? capacity : 0,
		},
		probeError: getOwnString(body, 'probeError') ?? null,
		release: normalizeReleaseInfo(
			isPlainObject(release) ? getOwnString(release, 'version') : null,
			isPlainObject(release) ? getOwnString(release, 'commit') : null,
		),
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
	options: {
		contestationPeriodSeconds?: number;
		depositPeriodSeconds?: number;
		unsyncedPeriodSeconds?: number;
		depositActivationSeconds?: number;
	},
	transport: HostTransportOptions,
): Promise<ProvisionedNode> {
	const body = await request(baseUrl, '/v1/nodes', adminToken, transport, {
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

	// The Host may override the activation we asked for
	// (HYDRA_HOST_DEPOSIT_ACTIVATION_SECONDS). It is a deliberate operator
	// escape hatch, so this does not refuse the provision. It must not pass
	// silently either: each side evaluates a deposit's absorb window against
	// its OWN activation, so an override on one Host of a head makes the two
	// windows stop overlapping and no top-up can ever be co-signed, while both
	// sides keep rendering usableFrom/absorbBy normally because those derive
	// from the deadline. Nothing else on the wire reports this.
	const effectiveActivation = getOwnValue(body, 'depositActivationSeconds');
	if (
		options.depositActivationSeconds !== undefined &&
		typeof effectiveActivation === 'number' &&
		effectiveActivation !== options.depositActivationSeconds
	) {
		logger.warn('[HydraHost] host overrode the deposit activation it was asked for', {
			baseUrl,
			requested: options.depositActivationSeconds,
			effective: effectiveActivation,
		});
	}

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
export async function acknowledgeEscrowOnHost(
	baseUrl: string,
	adminToken: string,
	nodeId: string,
	transport: HostTransportOptions,
): Promise<void> {
	await request(baseUrl, `/v1/nodes/${nodeId}/escrow-ack`, adminToken, transport, { method: 'POST' });
}

export async function setHostNodePeers(
	baseUrl: string,
	adminToken: string,
	nodeId: string,
	peers: HostPeer[],
	transport: HostTransportOptions,
): Promise<void> {
	await request(baseUrl, `/v1/nodes/${nodeId}`, adminToken, transport, { method: 'PATCH', body: { peers } });
}

/** The peers a node is configured with, from the Host's own record of it. */
export async function fetchHostNodePeers(
	baseUrl: string,
	adminToken: string,
	nodeId: string,
	transport: HostTransportOptions,
): Promise<HostPeer[]> {
	const body = await request(baseUrl, `/v1/nodes/${nodeId}`, adminToken, transport);
	const peers = isPlainObject(body) ? getOwnValue(body, 'peers') : undefined;
	if (!Array.isArray(peers)) {
		throw new HydraProtocolError('hydra host returned a malformed node record');
	}
	return peers.map((peer) => {
		const advertise = isPlainObject(peer) ? getOwnString(peer, 'advertise') : undefined;
		const hydraVerificationKey = isPlainObject(peer) ? getOwnString(peer, 'hydraVerificationKey') : undefined;
		const cardanoVerificationKey = isPlainObject(peer) ? getOwnString(peer, 'cardanoVerificationKey') : undefined;
		if (advertise === undefined || hydraVerificationKey === undefined || cardanoVerificationKey === undefined) {
			throw new HydraProtocolError('hydra host returned a malformed node record');
		}
		return { advertise, hydraVerificationKey, cardanoVerificationKey };
	});
}

export type HostPeerCheck = {
	/** False when the Host predates the check, so nothing was actually asked. */
	supported: boolean;
	allowed: boolean;
	reason: string | null;
};

/**
 * Ask a Host whether it would accept `advertise` as a node's peer, without
 * changing anything. Setting a node's peers is what refuses a private or
 * unresolvable address, and that happens after a redemption has spent the
 * invite's nonce; this asks the same question before.
 *
 * A Host with no such route answers 404. That is "cannot check", not a refusal,
 * so the caller proceeds as it always did.
 */
export async function checkHostPeerTarget(
	baseUrl: string,
	adminToken: string,
	advertise: string,
	transport: HostTransportOptions,
): Promise<HostPeerCheck> {
	let body: unknown;
	try {
		body = await request(baseUrl, '/v1/peers/check', adminToken, transport, {
			method: 'POST',
			body: { advertise },
		});
	} catch (error) {
		if (error instanceof HydraHostRequestError && error.status === 404) {
			return { supported: false, allowed: true, reason: null };
		}
		throw error;
	}
	if (!isPlainObject(body) || typeof getOwnValue(body, 'allowed') !== 'boolean') {
		throw new HydraProtocolError('hydra host returned a malformed peer check');
	}
	const allowed = getOwnValue(body, 'allowed') === true;
	return { supported: true, allowed, reason: allowed ? null : (getOwnString(body, 'reason') ?? null) };
}

export type HostNodeHealth = {
	state: string;
	/** The state an operator asked for. A stop request leaves `state` Running until the node drains. */
	desired: string | null;
	/** A restart was requested and the Host has not carried it out yet. */
	restartRequested: boolean;
	usable: boolean;
	responsive: boolean;
	chainSynced: boolean | null;
	/** False when the Host has no recent supervisor observation, including older Hosts that omit the field. */
	observationFresh: boolean;
	/** How far behind the chain the node is, in seconds. Null when unknown. */
	driftSeconds: number | null;
};

/**
 * Whether a node can actually be driven right now.
 *
 * A node that has been provisioned is not immediately a node that can post a
 * transaction: it has to start and catch up on chain first, and an L1 action
 * attempted in that window fails as "unreachable" — which describes the symptom
 * and not the cause.
 */
export async function fetchHostNodeHealth(
	baseUrl: string,
	userToken: string,
	nodeId: string,
	transport: HostTransportOptions,
): Promise<HostNodeHealth> {
	const body = await request(baseUrl, `/v1/nodes/${nodeId}/health`, userToken, transport);
	if (!isPlainObject(body)) {
		throw new HydraProtocolError('hydra host returned a malformed node health response');
	}
	return {
		state: getOwnString(body, 'state') ?? 'Unknown',
		desired: getOwnString(body, 'desired') ?? null,
		restartRequested: getOwnValue(body, 'restartRequested') === true,
		usable: getOwnValue(body, 'usable') === true,
		responsive: getOwnValue(body, 'responsive') === true,
		chainSynced:
			typeof getOwnValue(body, 'chainSynced') === 'boolean' ? (getOwnValue(body, 'chainSynced') as boolean) : null,
		observationFresh: getOwnValue(body, 'observationFresh') === true,
		driftSeconds:
			typeof getOwnValue(body, 'driftSeconds') === 'number' ? (getOwnValue(body, 'driftSeconds') as number) : null,
	};
}

/** Ask the Host's supervisor to run this node. Idempotent; the Host owns the transition. */
export async function startHostNode(
	baseUrl: string,
	adminToken: string,
	nodeId: string,
	transport: HostTransportOptions,
): Promise<void> {
	await request(baseUrl, `/v1/nodes/${nodeId}/start`, adminToken, transport, { method: 'POST' });
}

/**
 * Ask the Host's supervisor to stop this node. Idempotent. The Host drains the
 * node's snapshot round before it stops it, and keeps it stopped across a Host
 * restart until it is started again.
 */
export async function stopHostNode(
	baseUrl: string,
	adminToken: string,
	nodeId: string,
	transport: HostTransportOptions,
): Promise<void> {
	await request(baseUrl, `/v1/nodes/${nodeId}/stop`, adminToken, transport, { method: 'POST' });
}

export async function removeHostNode(
	baseUrl: string,
	adminToken: string,
	nodeId: string,
	options: { force: boolean; allowInsecureHttp: boolean },
): Promise<void> {
	const query = options.force ? '?force=true' : '';
	await request(baseUrl, `/v1/nodes/${nodeId}${query}`, adminToken, options, { method: 'DELETE' });
}

/** An old Host returns 404 for this route. Verify whether its node still exists before treating that as removal. */
export async function removeUnclaimedHostNode(
	baseUrl: string,
	adminToken: string,
	nodeId: string,
	transport: HostTransportOptions,
): Promise<void> {
	try {
		await request(baseUrl, `/v1/nodes/${nodeId}/remove-unclaimed`, adminToken, transport, { method: 'DELETE' });
	} catch (error) {
		if (!(error instanceof HydraHostRequestError) || error.status !== 404) throw error;
		try {
			await request(baseUrl, `/v1/nodes/${nodeId}`, adminToken, transport);
		} catch (readError) {
			// A wrong proxy prefix can make both routes return 404. Require the
			// Host's node-specific answer before treating the node as gone.
			if (
				readError instanceof HydraHostRequestError &&
				readError.status === 404 &&
				readError.message.endsWith(': no such node')
			)
				return;
			throw readError;
		}
		throw error;
	}
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
export function hostNodeUrls(
	baseUrl: string,
	nodeId: string,
	transport: HostTransportOptions,
): { nodeUrl: string; nodeHttpUrl: string } {
	const httpUrl = joinUrl(baseUrl, `/v1/nodes/${nodeId}/api`, transport);
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

// Match the Host's wire ceilings without constraining wallet or signature formats.
const HOST_INVITE_LIMITS = {
	identifier: 64,
	walletAddress: 256,
	verificationKey: 68,
	advertise: 259,
	exchangeUrl: 2048,
	signature: 4096,
};
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const hostTimestampSchema = z.number().finite().nonnegative().max(MAX_DATE_TIMESTAMP_MS);
const hostInviteNonceSchema = z.object({ nonce: z.string().min(1).max(HOST_INVITE_LIMITS.identifier) });
const hostInviteRecordSchema = hostInviteNonceSchema.extend({
	hostNodeId: z.string().min(1).max(HOST_INVITE_LIMITS.identifier),
	expiresAt: hostTimestampSchema,
	redeemedAt: hostTimestampSchema.nullable(),
	redeemer: z
		.object({
			walletAddress: z.string().min(1).max(HOST_INVITE_LIMITS.walletAddress),
			hydraVerificationKey: z.string().min(1).max(HOST_INVITE_LIMITS.verificationKey),
			cardanoVerificationKey: z.string().min(1).max(HOST_INVITE_LIMITS.verificationKey),
			advertise: z.string().min(1).max(HOST_INVITE_LIMITS.advertise),
			exchangeUrl: z.string().min(1).max(HOST_INVITE_LIMITS.exchangeUrl),
		})
		.nullable(),
	redeemerSignature: z
		.object({
			signature: z.string().min(1).max(HOST_INVITE_LIMITS.signature),
			key: z.string().min(1).max(HOST_INVITE_LIMITS.signature),
		})
		.nullable(),
	startError: z.string().nullable(),
});
const hostInviteResponseSchema = z.object({ invites: z.array(z.unknown()), now: hostTimestampSchema });

/**
 * Tell a Host to honour an invite we just minted.
 *
 * The Host is given only the nonce, the reserved node and an expiry, never the
 * signed invite. It verifies the redeemer's signature against its own network
 * config and needs nothing from the invite for that. Keeping the material out
 * of it means a Host compromise leaks nothing about who we are negotiating
 * with beyond what the peer plane already reveals.
 */
export async function registerInviteOnHost(
	baseUrl: string,
	adminToken: string,
	invite: { nonce: string; hostNodeId: string; expiresAt: number },
	transport: HostTransportOptions,
): Promise<void> {
	await request(baseUrl, '/v1/invites', adminToken, transport, { method: 'POST', body: invite });
}

/** Redemptions since the watermark. One request however many invites are outstanding. */
export async function fetchHostRedemptions(
	baseUrl: string,
	adminToken: string,
	redeemedSince: number,
	transport: HostTransportOptions,
): Promise<{ invites: HostInviteRecord[]; unreadableNonces: string[]; now: number }> {
	const body = await request(baseUrl, `/v1/invites?redeemedSince=${redeemedSince}`, adminToken, transport);
	// Reject the whole batch before adoption or watermark updates can use it.
	const parsed = hostInviteResponseSchema.safeParse(body);
	if (!parsed.success) {
		throw new HydraProtocolError('hydra host returned a malformed invite list');
	}
	// Skip a malformed record rather than the batch. It can never be adopted, and
	// failing the batch would also block every other adoption, revoke and expiry
	// sweep on this Host. The Host lists only redeemed records and refuses to
	// forget one unless told to discard it, so revoke and the sweep must still
	// count a skipped record's nonce as held.
	const invites: HostInviteRecord[] = [];
	const unreadableNonces: string[] = [];
	for (const record of parsed.data.invites) {
		const invite = hostInviteRecordSchema.safeParse(record);
		if (invite.success) {
			invites.push(invite.data);
			continue;
		}
		const nonce = hostInviteNonceSchema.safeParse(record);
		if (nonce.success) unreadableNonces.push(nonce.data.nonce);
		logger.warn(
			`hydra host listed a malformed invite record${nonce.success ? ` ${nonceLogRef(nonce.data.nonce)}` : ''}; skipping it`,
		);
	}
	return { invites, unreadableNonces, now: parsed.data.now };
}

/**
 * Forget an invite on the Host.
 *
 * `keepReplay` is for a redemption this service adopted: the Host keeps the
 * redeemer's public material for seven days so an identical replay is still
 * answered, which is how a redeemer whose answer was lost learns it succeeded.
 * A cancelled redemption must set `discardRedemption`. Ordinary revocation
 * leaves both flags unset, so the Host refuses to erase a raced redemption.
 * An older Host ignores these flags and must be upgraded before this guard works.
 */
export async function forgetHostInvite(
	baseUrl: string,
	adminToken: string,
	nonce: string,
	transport: HostTransportOptions,
	options: { keepReplay?: boolean; discardRedemption?: boolean } = {},
): Promise<void> {
	// The error message ends up in logs while the nonce may still be redeemable.
	const query =
		options.keepReplay === true
			? '?keepReplay=true'
			: options.discardRedemption === true
				? '?discardRedemption=true'
				: '';
	await request(baseUrl, `/v1/invites/${nonce}${query}`, adminToken, transport, {
		method: 'DELETE',
		logPath: `/v1/invites/${nonceLogRef(nonce)}`,
	});
}
