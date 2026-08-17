/**
 * Registering and maintaining Hydra Host deployments.
 *
 * Tokens are encrypted on the way in and never returned. A Host row is the only
 * thing standing between this service and an unauthenticated node API, so the
 * decrypted values exist for exactly as long as a request needs them.
 */

import createHttpError from 'http-errors';
import { HydraHeadStatus, HydraHostStatus, HydraInviteStatus, Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { decrypt, encrypt } from '@/utils/security/encryption';
import { assertUsableHydraAuthToken } from '@/lib/hydra/hydra/auth';
import { validateHydraHttpUrl } from '@/lib/hydra/hydra/node-url';
import { getOwnString, isPlainObject } from '@masumi/payment-core/object-properties';
import { fetchHostCapabilities, type HostCapabilities } from './client';
import { expectedHostCapabilitiesForNetwork } from './compatibility';
import { assertHostCompatible } from './placement';

/** Shape returned to operators. Deliberately excludes both tokens. */
export type PublicHydraHost = {
	id: string;
	createdAt: string;
	updatedAt: string;
	name: string;
	network: Network;
	baseUrl: string;
	allowInsecureHttp: boolean;
	publicPeerHost: string;
	hasAdminToken: boolean;
	hydraVersion: string | null;
	scriptCatalogueHash: string | null;
	ledgerParamsHash: string | null;
	status: HydraHostStatus;
	lastHealthAt: string | null;
	lastHealthError: string | null;
	participantCount: number;
};

type HostRow = {
	id: string;
	createdAt: Date;
	updatedAt: Date;
	name: string;
	network: Network;
	baseUrl: string;
	allowInsecureHttp: boolean;
	publicPeerHost: string;
	encryptedAdminToken: string | null;
	hydraVersion: string | null;
	scriptCatalogueHash: string | null;
	ledgerParamsHash: string | null;
	status: HydraHostStatus;
	lastHealthAt: Date | null;
	lastHealthError: string | null;
	_count: { Participants: number };
};

export function toPublicHydraHost(row: HostRow): PublicHydraHost {
	return {
		id: row.id,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		name: row.name,
		network: row.network,
		baseUrl: row.baseUrl,
		allowInsecureHttp: row.allowInsecureHttp,
		publicPeerHost: row.publicPeerHost,
		// Presence, never the value: an operator needs to know whether this Host
		// can be provisioned on, not what the credential is.
		hasAdminToken: row.encryptedAdminToken !== null,
		hydraVersion: row.hydraVersion,
		scriptCatalogueHash: row.scriptCatalogueHash,
		ledgerParamsHash: row.ledgerParamsHash,
		status: row.status,
		lastHealthAt: row.lastHealthAt?.toISOString() ?? null,
		lastHealthError: row.lastHealthError,
		participantCount: row._count.Participants,
	};
}

/**
 * The status a Host should hold after a probe.
 *
 * Draining and Disabled are operator intent and a probe never overrides them —
 * including on failure. Getting this wrong is silent: a draining Host that
 * failed one probe would come back as Active on the next success and quietly
 * start accepting placements again, undoing the drain.
 */
export function nextHostStatus(current: HydraHostStatus, probeSucceeded: boolean): HydraHostStatus {
	if (current === HydraHostStatus.Disabled || current === HydraHostStatus.Draining) {
		return current;
	}
	return probeSucceeded ? HydraHostStatus.Active : HydraHostStatus.Unreachable;
}

/** Truncate for storage, marking that it was cut so it does not read as complete. */
function truncateError(message: string, limit = 500): string {
	return message.length <= limit ? message : `${message.slice(0, limit - 1)}\u2026`;
}

/** A control-plane URL must be an absolute https/http origin with no credentials. */
export function normalizeHostBaseUrl(rawUrl: string, allowInsecureHttp = false): string {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw createHttpError(400, 'baseUrl must be an absolute URL');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw createHttpError(400, 'baseUrl must be http or https');
	}
	if (parsed.username.length > 0 || parsed.password.length > 0) {
		throw createHttpError(400, 'baseUrl must not embed credentials; tokens are sent as headers');
	}
	if (parsed.search.length > 0 || parsed.hash.length > 0) {
		throw createHttpError(400, 'baseUrl must not carry a query string or fragment');
	}
	if (parsed.protocol === 'http:' && !allowInsecureHttp) {
		throw createHttpError(
			400,
			'baseUrl uses HTTP; set allowInsecureHttp to acknowledge that bearer tokens will cross plaintext transport',
		);
	}
	try {
		validateHydraHttpUrl(rawUrl, {
			plaintextHosts: parsed.protocol === 'http:' ? [parsed.hostname] : [],
		});
	} catch (error) {
		throw createHttpError(400, (error as Error).message);
	}
	// Trailing slashes are stripped so the unique (network, baseUrl) constraint
	// cannot be sidestepped by registering the same Host twice.
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * A bearer credential is one unbroken run of non-space characters — the header
 * is `Bearer` followed by `\S+` and nothing else. A token with a space or a tab
 * inside it therefore produces a header the Host rejects as *malformed*, which
 * surfaces as a bare 401 saying the Authorization header is missing. That is
 * close to undiagnosable: the request looks unauthenticated, the token looks
 * right in the database, and nothing points at the whitespace.
 *
 * It happens by copy-paste, where a label or a column separator is dragged
 * along with the value — an observed cause of exactly that 401.
 */
const TOKEN_INNER_WHITESPACE = /\s/;

/**
 * The exact string that should be stored for a pasted token, or a 400.
 *
 * Trimming absorbs the harmless half of a paste; whatever whitespace survives
 * is refused rather than stored, because a token that cannot form a valid
 * header must not reach the database. Checked here rather than in
 * `assertUsableHydraAuthToken`, which also runs against tokens already stored
 * and must not start rejecting them.
 */
/**
 * The hostname a counterparty should dial, taken from the control-plane URL.
 *
 * Right in every deployment where peers and this service reach the Host by the
 * same name, which is the normal case. Asking for it separately made an
 * operator supply a value they had already typed, and get it wrong.
 */
function hostOfUrl(baseUrl: string): string {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return baseUrl;
	}
}

export function normalizeHostToken(token: string, field: string): string {
	const trimmed = token.trim();
	try {
		assertUsableHydraAuthToken(trimmed);
	} catch (error) {
		throw createHttpError(400, `${field}: ${(error as Error).message}`);
	}
	if (TOKEN_INNER_WHITESPACE.test(trimmed)) {
		throw createHttpError(
			400,
			`${field}: must not contain spaces or tabs. Paste only the key itself, without its label`,
		);
	}
	return trimmed;
}

function validateToken(token: string, field: string): string {
	return encrypt(normalizeHostToken(token, field));
}

/** The network a Host belongs to, for scoping an api key's authority over it. */
export async function readHydraHostNetwork(id: string): Promise<Network> {
	const host = await prisma.hydraHost.findUnique({ where: { id }, select: { network: true } });
	if (!host) {
		throw createHttpError(404, 'hydra host not found');
	}
	return host.network;
}

export async function listHydraHosts(networks: Network[]): Promise<PublicHydraHost[]> {
	const rows = await prisma.hydraHost.findMany({
		where: { network: { in: networks } },
		include: { _count: { select: { Participants: true } } },
		orderBy: [{ network: 'asc' }, { name: 'asc' }],
	});
	return rows.map(toPublicHydraHost);
}

export async function registerHydraHost(input: {
	name: string;
	network: Network;
	baseUrl: string;
	allowInsecureHttp: boolean;
	publicPeerHost?: string;
	userToken?: string;
	adminToken: string;
}): Promise<PublicHydraHost> {
	const baseUrl = normalizeHostBaseUrl(input.baseUrl, input.allowInsecureHttp);
	const allowInsecureHttp = new URL(baseUrl).protocol === 'http:' && input.allowInsecureHttp;
	if (allowInsecureHttp) {
		logger.warn(
			`hydra: registering ${input.name} at ${baseUrl} with explicitly allowed HTTP; bearer tokens are not transport-encrypted`,
		);
	}
	// The admin token satisfies every runtime call too, so a Host registered with
	// only an admin token works completely. Storing it in both slots keeps the
	// runtime path unchanged and leaves room to rotate a lower-privilege token in
	// later without a migration.
	const encryptedAdminToken = validateToken(input.adminToken, 'adminToken');
	const encryptedUserToken =
		input.userToken === undefined ? encryptedAdminToken : validateToken(input.userToken, 'userToken');

	// Rely on the unique index rather than a read-then-write check: two
	// concurrent registrations would both pass a pre-check, and the caller
	// deserves the intended 409 rather than a raw constraint violation.
	try {
		const created = await prisma.hydraHost.create({
			data: {
				name: input.name,
				network: input.network,
				baseUrl,
				allowInsecureHttp,
				publicPeerHost: input.publicPeerHost ?? hostOfUrl(baseUrl),
				encryptedUserToken,
				encryptedAdminToken,
				// A new Host has not yet proved it matches the service-owned
				// compatibility manifest. The first successful check activates it.
				status: HydraHostStatus.Unreachable,
			},
			include: { _count: { select: { Participants: true } } },
		});

		// Probe immediately, because connecting a node is exactly when its facts
		// should be learned. One of them — the Exchange Plane port — is baked into
		// every invite this Host issues, and a Host that has never been probed
		// cannot mint one. Best-effort: a Host that is registered while briefly
		// unreachable is still registered, and the next Check fills this in.
		try {
			return await refreshHydraHostCapabilities(created.id);
		} catch {
			return toPublicHydraHost(created);
		}
	} catch (error) {
		if (isPlainObject(error) && getOwnString(error, 'code') === 'P2002') {
			throw createHttpError(409, `a hydra host for ${input.network} at ${baseUrl} is already registered`);
		}
		throw error;
	}
}

export async function updateHydraHost(
	id: string,
	input: {
		name?: string;
		status?: HydraHostStatus;
		userToken?: string;
		adminToken?: string | null;
		allowInsecureHttp?: boolean;
	},
): Promise<PublicHydraHost> {
	const existing = await prisma.hydraHost.findUnique({ where: { id } });
	if (!existing) {
		throw createHttpError(404, 'hydra host not found');
	}
	if (input.allowInsecureHttp === true) {
		normalizeHostBaseUrl(existing.baseUrl, true);
	}

	const updated = await prisma.hydraHost.update({
		where: { id },
		data: {
			...(input.name === undefined ? {} : { name: input.name }),
			...(input.status === undefined ? {} : { status: input.status }),
			...(input.allowInsecureHttp === undefined
				? {}
				: {
						allowInsecureHttp: new URL(existing.baseUrl).protocol === 'http:' && input.allowInsecureHttp,
					}),
			...(input.userToken === undefined ? {} : { encryptedUserToken: validateToken(input.userToken, 'userToken') }),
			...(input.adminToken === undefined
				? {}
				: { encryptedAdminToken: input.adminToken === null ? null : validateToken(input.adminToken, 'adminToken') }),
		},
		include: { _count: { select: { Participants: true } } },
	});
	if (input.allowInsecureHttp === true && updated.allowInsecureHttp) {
		logger.warn(
			`hydra: HTTP explicitly enabled for ${updated.name} at ${updated.baseUrl}; bearer tokens are not transport-encrypted`,
		);
	}
	return toPublicHydraHost(updated);
}

export async function deleteHydraHost(id: string): Promise<void> {
	const existing = await prisma.hydraHost.findUnique({ where: { id } });
	if (!existing) {
		throw createHttpError(404, 'hydra host not found');
	}

	// Every participant blocks removal, not just the live ones.
	//
	// A participant records which node held a head — its host, node id and commit
	// transactions — and every node is provisioned through a Host, so that link
	// cannot be detached. Previously a finalised head's participant was nulled
	// out to let the Host go; with the Host now required, doing that would mean
	// deleting the participant and losing the head's node identity along with it.
	// Removing the finalised heads first is the honest order, and there is
	// already a guard for that.
	const participants = await prisma.hydraLocalParticipant.count({ where: { hydraHostId: id } });
	if (participants > 0) {
		const live = await prisma.hydraLocalParticipant.count({
			where: {
				hydraHostId: id,
				OR: [{ HydraHead: { is: null } }, { HydraHead: { status: { not: HydraHeadStatus.Final } } }],
			},
		});
		// The database would refuse this anyway (the relation is Restrict); saying
		// why is more useful than surfacing a constraint violation.
		throw createHttpError(
			409,
			live > 0
				? `this hydra host still runs ${live} node(s) on live heads; those heads cannot be moved, so close and remove them first`
				: `this hydra host holds ${participants} node(s) from finalised heads; remove those heads first`,
		);
	}

	// Invites hold the Host too, and nothing ever deletes an invite row: reaping
	// and revoking only move it to a terminal status. Left unhandled, the first
	// invite a Host ever issued made it undeletable for good — the participant
	// guard above passed, the delete hit the invite foreign key, and the operator
	// got a bare 500 naming a constraint rather than the thing to do about it.
	const liveInvites = await prisma.hydraHeadInvite.count({
		where: {
			hydraHostId: id,
			status: { in: [HydraInviteStatus.Issued, HydraInviteStatus.Redeemed, HydraInviteStatus.Started] },
		},
	});
	if (liveInvites > 0) {
		throw createHttpError(
			409,
			`this hydra host has ${liveInvites} invite(s) still outstanding; revoke them first, or wait for them to expire`,
		);
	}

	// The remaining rows are finished invites, and an invite that named a Host
	// this service no longer has is a record of nothing. Deleted with the Host
	// rather than before it, so a failure leaves both.
	await prisma.$transaction(async (tx) => {
		await tx.hydraHeadInvite.deleteMany({ where: { hydraHostId: id } });
		await tx.hydraHost.delete({ where: { id } });
	});
}

/**
 * Ask a Host what it is running and record the answer.
 *
 * Health is recorded rather than inferred: a Host that fails a probe keeps its
 * existing placements, because a head cannot be moved. Marking it `Unreachable`
 * stops new placements without disturbing the heads already there.
 */
export async function refreshHydraHostCapabilities(id: string): Promise<PublicHydraHost> {
	const host = await prisma.hydraHost.findUnique({ where: { id } });
	if (!host) {
		throw createHttpError(404, 'hydra host not found');
	}
	if (host.encryptedAdminToken === null) {
		throw createHttpError(409, 'this hydra host is registered without an admin token, so it cannot be probed');
	}

	let capabilities: HostCapabilities;
	try {
		capabilities = await fetchHostCapabilities(host.baseUrl, decrypt(host.encryptedAdminToken), {
			allowInsecureHttp: host.allowInsecureHttp,
		});
	} catch (error) {
		const updated = await prisma.hydraHost.update({
			where: { id },
			data: {
				status: nextHostStatus(host.status, false),
				lastHealthAt: new Date(),
				lastHealthError: truncateError((error as Error).message),
			},
			include: { _count: { select: { Participants: true } } },
		});
		return toPublicHydraHost(updated);
	}

	let compatibilityError: string | null = null;
	try {
		assertHostCompatible(capabilities, expectedHostCapabilitiesForNetwork(host.network));
	} catch (error) {
		compatibilityError = (error as Error).message;
	}

	const updated = await prisma.hydraHost.update({
		where: { id },
		data: {
			hydraVersion: capabilities.hydraVersion || null,
			// Kept only when the Host reports one, so a probe against an older
			// Host does not erase a value a newer one already supplied.
			...(capabilities.exchangePort === null ? {} : { exchangePort: capabilities.exchangePort }),
			scriptCatalogueHash: capabilities.scriptCatalogueHash,
			// An observation, for the operator to look at. Never an expectation:
			// this is written even when the compatibility check just failed on it,
			// so anything comparing a Host against this column compares it against
			// itself.
			ledgerParamsHash: capabilities.ledgerParamsHash,
			status: nextHostStatus(host.status, compatibilityError === null),
			lastHealthAt: new Date(),
			lastHealthError: compatibilityError === null ? null : truncateError(compatibilityError),
		},
		include: { _count: { select: { Participants: true } } },
	});
	return toPublicHydraHost(updated);
}
