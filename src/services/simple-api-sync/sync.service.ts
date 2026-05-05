import { createHash } from 'crypto';
import { Network, Prisma, SimpleApiStatus } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { CONFIG } from '@/utils/config';
import { logger } from '@/utils/logger';

interface RegistryQueryBody {
	network: Network;
	limit: number;
	cursorId?: string;
}

interface RegistryDiffBody {
	network: Network;
	statusUpdatedAfter: string;
	limit: number;
	cursorId?: string;
}

interface RegistryAcceptEntry {
	scheme: string;
	network: string;
	maxAmountRequired: string;
	payTo: string;
	asset: string;
	resource: string;
	description: string | null;
	mimeType: string | null;
}

interface RegistrySimpleApiListing {
	id: string;
	entryType: 'SimpleApi';
	network: 'Preprod' | 'Mainnet';
	name: string;
	description: string | null;
	url: string;
	category: string | null;
	tags: string[];
	accepts: RegistryAcceptEntry[];
	extra: Prisma.JsonObject | null;
	httpMethod: string | null;
	status: 'Online' | 'Offline' | 'Invalid' | 'Deregistered';
	lastActiveAt: string | null;
	statusUpdatedAt: string;
	createdAt: string;
	updatedAt: string;
}

interface RegistryListingsResponse {
	status: string;
	data: {
		listings: RegistrySimpleApiListing[];
		cursor?: string | null;
	};
}

function normalizeUrl(url: string): string {
	try {
		const parsed = new URL(url.trim().toLowerCase());
		return parsed.toString();
	} catch {
		return url.trim().toLowerCase();
	}
}

function urlHash(url: string): string {
	return createHash('sha256').update(normalizeUrl(url)).digest('hex');
}

function toSimpleApiStatus(status: string): SimpleApiStatus {
	switch (status) {
		case 'Online':
			return SimpleApiStatus.Online;
		case 'Offline':
			return SimpleApiStatus.Offline;
		case 'Invalid':
			return SimpleApiStatus.Invalid;
		case 'Deregistered':
			return SimpleApiStatus.Deregistered;
		default:
			return SimpleApiStatus.Offline;
	}
}

function buildUpsertData(listing: RegistrySimpleApiListing) {
	const firstAccept = listing.accepts[0];
	return {
		registryListingId: listing.id,
		urlHash: urlHash(listing.url),
		network: listing.network as Network,
		name: listing.name,
		description: listing.description ?? null,
		url: listing.url,
		category: listing.category ?? null,
		tags: listing.tags,
		httpMethod: listing.httpMethod ?? null,
		status: toSimpleApiStatus(listing.status),
		lastActiveAt: listing.lastActiveAt ? new Date(listing.lastActiveAt) : null,
		statusUpdatedAt: new Date(listing.statusUpdatedAt),
		lastSyncedAt: new Date(),
		paymentScheme: firstAccept?.scheme ?? null,
		x402Network: firstAccept?.network ?? null,
		maxAmountRequired: firstAccept?.maxAmountRequired ? BigInt(firstAccept.maxAmountRequired) : null,
		payTo: firstAccept?.payTo ?? null,
		asset: firstAccept?.asset ?? null,
		resource: firstAccept?.resource ?? null,
		mimeType: firstAccept?.mimeType ?? null,
		rawAccepts: listing.accepts.length > 0 ? (listing.accepts as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
		extra:
			listing.extra != null && Object.keys(listing.extra).length > 0
				? (listing.extra as unknown as Prisma.InputJsonValue)
				: Prisma.JsonNull,
	};
}

async function upsertListings(listings: RegistrySimpleApiListing[]): Promise<void> {
	if (listings.length === 0) return;

	const results = await Promise.allSettled(
		listings.map(async (listing) => {
			const data = buildUpsertData(listing);
			await prisma.simpleApiListing.upsert({
				where: { registryListingId: listing.id },
				create: data,
				update: data,
			});
		}),
	);

	const failed = results.filter((r) => r.status === 'rejected');
	if (failed.length > 0) {
		logger.warn('SimpleApi sync: some listings failed to upsert', {
			failedCount: failed.length,
			totalCount: listings.length,
		});
	}
}

async function fetchFullSync(network: Network): Promise<void> {
	if (!CONFIG.REGISTRY_SERVICE_URL) {
		logger.warn('SimpleApi sync skipped: REGISTRY_SERVICE_URL not configured');
		return;
	}

	logger.info('SimpleApi sync: starting full sync', { network });

	let cursorId: string | null = null;
	let pageCount = 0;

	do {
		const body: RegistryQueryBody = { network, limit: 100, ...(cursorId != null ? { cursorId } : {}) };

		let response: Response;
		try {
			response = await fetch(`${CONFIG.REGISTRY_SERVICE_URL}/api/v1/simple-api-listing-query`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					token: CONFIG.REGISTRY_API_KEY,
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			logger.error('SimpleApi sync: registry fetch error during full sync', { network, error: err });
			return;
		}

		if (!response.ok) {
			logger.error('SimpleApi sync: registry returned non-OK during full sync', {
				network,
				status: response.status,
			});
			return;
		}

		let json: RegistryListingsResponse;
		try {
			json = (await response.json()) as RegistryListingsResponse;
		} catch (err) {
			logger.error('SimpleApi sync: failed to parse registry full sync response', { network, error: err });
			return;
		}

		const listings = json.data?.listings ?? [];
		await upsertListings(listings);

		cursorId = json.data?.cursor ?? null;
		pageCount++;
		logger.debug('SimpleApi sync: full sync page completed', {
			network,
			page: pageCount,
			count: listings.length,
			hasMore: cursorId != null,
		});
	} while (cursorId != null);

	logger.info('SimpleApi sync: full sync completed', { network, pages: pageCount });
}

const lastSyncCursors: Partial<Record<Network, { statusUpdatedAfter: string; cursorId: string | null }>> = {};

async function fetchIncrementalSync(network: Network): Promise<void> {
	if (!CONFIG.REGISTRY_SERVICE_URL) return;

	const cursor = lastSyncCursors[network];
	if (!cursor) {
		await fetchFullSync(network);
		const mostRecent = await prisma.simpleApiListing.findFirst({
			where: { network },
			orderBy: { statusUpdatedAt: 'desc' },
			select: { statusUpdatedAt: true },
		});
		lastSyncCursors[network] = {
			statusUpdatedAfter: mostRecent?.statusUpdatedAt.toISOString() ?? new Date(0).toISOString(),
			cursorId: null,
		};
		return;
	}

	let cursorId: string | null = cursor.cursorId;
	const statusUpdatedAfter = cursor.statusUpdatedAfter;
	let pageCount = 0;
	let newStatusUpdatedAfter = statusUpdatedAfter;

	do {
		const body: RegistryDiffBody = {
			network,
			statusUpdatedAfter,
			limit: 100,
			...(cursorId != null ? { cursorId } : {}),
		};

		let response: Response;
		try {
			response = await fetch(`${CONFIG.REGISTRY_SERVICE_URL}/api/v1/simple-api-listing-diff`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					token: CONFIG.REGISTRY_API_KEY,
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			logger.error('SimpleApi sync: registry fetch error during incremental sync', { network, error: err });
			return;
		}

		if (!response.ok) {
			logger.error('SimpleApi sync: registry returned non-OK during incremental sync', {
				network,
				status: response.status,
			});
			return;
		}

		let json: RegistryListingsResponse;
		try {
			json = (await response.json()) as RegistryListingsResponse;
		} catch (err) {
			logger.error('SimpleApi sync: failed to parse registry incremental sync response', { network, error: err });
			return;
		}

		const listings = json.data?.listings ?? [];
		if (listings.length > 0) {
			await upsertListings(listings);

			const latestTimestamp = listings.reduce((latest, l) => {
				const ts = l.statusUpdatedAt;
				return ts > latest ? ts : latest;
			}, statusUpdatedAfter);

			if (latestTimestamp > newStatusUpdatedAfter) {
				newStatusUpdatedAfter = latestTimestamp;
			}
		}

		cursorId = json.data?.cursor ?? null;
		pageCount++;
	} while (cursorId != null);

	lastSyncCursors[network] = { statusUpdatedAfter: newStatusUpdatedAfter, cursorId: null };

	if (pageCount > 0) {
		logger.debug('SimpleApi sync: incremental sync completed', { network, pages: pageCount });
	}
}

export async function syncSimpleApiListings(): Promise<void> {
	await Promise.allSettled([fetchIncrementalSync(Network.Preprod), fetchIncrementalSync(Network.Mainnet)]);
}
