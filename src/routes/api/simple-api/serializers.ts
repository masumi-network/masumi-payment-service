import { Prisma, SimpleApiListing } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { simpleApiListingSchema } from './schemas';

type SimpleApiListingResponse = z.infer<typeof simpleApiListingSchema>;

interface RawAcceptEntry {
	scheme: string;
	network: string;
	maxAmountRequired: string;
	payTo: string;
	asset: string;
	resource: string;
	description: string | null;
	mimeType: string | null;
}

function parseRawAccepts(rawAccepts: Prisma.JsonValue): RawAcceptEntry[] {
	if (!Array.isArray(rawAccepts)) return [];
	return rawAccepts.flatMap((entry) => {
		if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return [];
		const e: Prisma.JsonObject = entry;
		return [
			{
				scheme: typeof e.scheme === 'string' ? e.scheme : '',
				network: typeof e.network === 'string' ? e.network : '',
				maxAmountRequired: typeof e.maxAmountRequired === 'string' ? e.maxAmountRequired : '0',
				payTo: typeof e.payTo === 'string' ? e.payTo : '',
				asset: typeof e.asset === 'string' ? e.asset : '',
				resource: typeof e.resource === 'string' ? e.resource : '',
				description: typeof e.description === 'string' ? e.description : null,
				mimeType: typeof e.mimeType === 'string' ? e.mimeType : null,
			},
		];
	});
}

function parseExtra(extra: Prisma.JsonValue | null): Prisma.JsonObject | null {
	if (extra == null || typeof extra !== 'object' || Array.isArray(extra)) return null;
	return extra;
}

export function serializeSimpleApiListing(listing: SimpleApiListing): SimpleApiListingResponse {
	return {
		id: listing.id,
		registryListingId: listing.registryListingId,
		entryType: 'SimpleApi',
		network: listing.network,
		name: listing.name,
		description: listing.description,
		url: listing.url,
		category: listing.category,
		tags: listing.tags,
		httpMethod: listing.httpMethod,
		status: listing.status,
		accepts: parseRawAccepts(listing.rawAccepts),
		extra: parseExtra(listing.extra),
		lastActiveAt: listing.lastActiveAt?.toISOString() ?? null,
		statusUpdatedAt: listing.statusUpdatedAt.toISOString(),
		createdAt: listing.createdAt.toISOString(),
		updatedAt: listing.updatedAt.toISOString(),
	};
}

export function serializeSimpleApiListings(listings: SimpleApiListing[]): SimpleApiListingResponse[] {
	return listings.map(serializeSimpleApiListing);
}
