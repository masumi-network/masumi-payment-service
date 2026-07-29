/**
 * Registering and maintaining Hydra Host deployments.
 *
 * Tokens are encrypted on the way in and never returned. A Host row is the only
 * thing standing between this service and an unauthenticated node API, so the
 * decrypted values exist for exactly as long as a request needs them.
 */

import createHttpError from 'http-errors';
import { HydraHostStatus, Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { decrypt, encrypt } from '@/utils/security/encryption';
import { assertUsableHydraAuthToken } from '@/lib/hydra/hydra/auth';
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
	_count?: { Participants: number };
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
		participantCount: row._count?.Participants ?? 0,
	};
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

export async function listHydraHosts(network?: Network): Promise<PublicHydraHost[]> {
	const rows = await prisma.hydraHost.findMany({
		where: network === undefined ? {} : { network },
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

	const existing = await prisma.hydraHost.findUnique({
		where: { network_baseUrl: { network: input.network, baseUrl } },
	});
	if (existing) {
		throw createHttpError(409, `a hydra host for ${input.network} at ${baseUrl} is already registered`);
	}

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
	const existing = await prisma.hydraHost.findUnique({
		where: { id },
		include: { _count: { select: { Participants: true } } },
	});
	if (!existing) {
		throw createHttpError(404, 'hydra host not found');
	}
	if (existing._count.Participants > 0) {
		// The database would refuse this anyway (the relation is Restrict); saying
		// why is more useful than surfacing a constraint violation.
		throw createHttpError(
			409,
			`this hydra host still runs ${existing._count.Participants} node(s); their heads cannot be moved, so close and remove them first`,
		);
	}
	await prisma.hydraHost.delete({ where: { id } });
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
				status: host.status === HydraHostStatus.Disabled ? host.status : HydraHostStatus.Unreachable,
				lastHealthAt: new Date(),
				lastHealthError: (error as Error).message.slice(0, 500),
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
			// A previously unreachable Host becomes eligible again once it answers.
			// Draining and Disabled are operator intent and are never overridden.
			status: host.status === HydraHostStatus.Unreachable ? HydraHostStatus.Active : host.status,
			lastHealthAt: new Date(),
			lastHealthError: null,
		},
		include: { _count: { select: { Participants: true } } },
	});
	return toPublicHydraHost(updated);
}
