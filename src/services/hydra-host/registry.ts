/**
 * Registering and maintaining Hydra Host deployments.
 *
 * Tokens are encrypted on the way in and never returned. A Host row is the only
 * thing standing between this service and an unauthenticated node API, so the
 * decrypted values exist for exactly as long as a request needs them.
 */

import createHttpError from 'http-errors';
import { HydraHeadStatus, HydraHostStatus, Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { decrypt, encrypt } from '@/utils/security/encryption';
import { assertUsableHydraAuthToken } from '@/lib/hydra/hydra/auth';
import { getOwnString, isPlainObject } from '@masumi/payment-core/object-properties';
import { fetchHostCapabilities, type HostCapabilities } from './client';

/** Shape returned to operators. Deliberately excludes both tokens. */
export type PublicHydraHost = {
	id: string;
	createdAt: string;
	updatedAt: string;
	name: string;
	network: Network;
	baseUrl: string;
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
export function normalizeHostBaseUrl(rawUrl: string): string {
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
	// Trailing slashes are stripped so the unique (network, baseUrl) constraint
	// cannot be sidestepped by registering the same Host twice.
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function validateToken(token: string, field: string): string {
	try {
		assertUsableHydraAuthToken(token);
	} catch (error) {
		throw createHttpError(400, `${field}: ${(error as Error).message}`);
	}
	return encrypt(token);
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
	publicPeerHost: string;
	userToken: string;
	adminToken?: string;
}): Promise<PublicHydraHost> {
	const baseUrl = normalizeHostBaseUrl(input.baseUrl);
	const encryptedUserToken = validateToken(input.userToken, 'userToken');
	const encryptedAdminToken = input.adminToken === undefined ? null : validateToken(input.adminToken, 'adminToken');

	// Rely on the unique index rather than a read-then-write check: two
	// concurrent registrations would both pass a pre-check, and the caller
	// deserves the intended 409 rather than a raw constraint violation.
	try {
		const created = await prisma.hydraHost.create({
			data: {
				name: input.name,
				network: input.network,
				baseUrl,
				publicPeerHost: input.publicPeerHost,
				encryptedUserToken,
				encryptedAdminToken,
			},
			include: { _count: { select: { Participants: true } } },
		});
		return toPublicHydraHost(created);
	} catch (error) {
		if (isPlainObject(error) && getOwnString(error, 'code') === 'P2002') {
			throw createHttpError(409, `a hydra host for ${input.network} at ${baseUrl} is already registered`);
		}
		throw error;
	}
}

export async function updateHydraHost(
	id: string,
	input: { name?: string; status?: HydraHostStatus; userToken?: string; adminToken?: string | null },
): Promise<PublicHydraHost> {
	const existing = await prisma.hydraHost.findUnique({ where: { id } });
	if (!existing) {
		throw createHttpError(404, 'hydra host not found');
	}

	const updated = await prisma.hydraHost.update({
		where: { id },
		data: {
			...(input.name === undefined ? {} : { name: input.name }),
			...(input.status === undefined ? {} : { status: input.status }),
			...(input.userToken === undefined ? {} : { encryptedUserToken: validateToken(input.userToken, 'userToken') }),
			...(input.adminToken === undefined
				? {}
				: { encryptedAdminToken: input.adminToken === null ? null : validateToken(input.adminToken, 'adminToken') }),
		},
		include: { _count: { select: { Participants: true } } },
	});
	return toPublicHydraHost(updated);
}

export async function deleteHydraHost(id: string): Promise<void> {
	const existing = await prisma.hydraHost.findUnique({ where: { id } });
	if (!existing) {
		throw createHttpError(404, 'hydra host not found');
	}

	// Only participants whose head is still live block removal. A participant
	// left behind by a finalised head holds no state worth protecting, and
	// counting it would make the Host permanently undeletable through the API.
	const liveParticipants = await prisma.hydraLocalParticipant.count({
		where: {
			hydraHostId: id,
			OR: [{ HydraHead: { is: null } }, { HydraHead: { status: { not: HydraHeadStatus.Final } } }],
		},
	});
	if (liveParticipants > 0) {
		// The database would refuse this anyway (the relation is Restrict); saying
		// why is more useful than surfacing a constraint violation.
		throw createHttpError(
			409,
			`this hydra host still runs ${liveParticipants} node(s) on live heads; those heads cannot be moved, so close and remove them first`,
		);
	}

	// Detach any finalised-head participants so the Restrict relation does not
	// block a Host whose work is genuinely done.
	await prisma.$transaction([
		prisma.hydraLocalParticipant.updateMany({ where: { hydraHostId: id }, data: { hydraHostId: null } }),
		prisma.hydraHost.delete({ where: { id } }),
	]);
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
		capabilities = await fetchHostCapabilities(host.baseUrl, decrypt(host.encryptedAdminToken));
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

	const updated = await prisma.hydraHost.update({
		where: { id },
		data: {
			hydraVersion: capabilities.hydraVersion || null,
			scriptCatalogueHash: capabilities.scriptCatalogueHash,
			ledgerParamsHash: capabilities.ledgerParamsHash,
			status: nextHostStatus(host.status, true),
			lastHealthAt: new Date(),
			lastHealthError: null,
		},
		include: { _count: { select: { Participants: true } } },
	});
	return toPublicHydraHost(updated);
}
