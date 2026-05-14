import { Network, SimpleApiStatus } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';

interface QueryListingsParams {
	limit: number;
	cursorId?: string;
	network: Network;
	filterStatus?: SimpleApiStatus;
	searchQuery?: string;
}

export async function getSimpleApiListingsForQuery(params: QueryListingsParams) {
	const { limit, cursorId, network, filterStatus, searchQuery } = params;

	const where = {
		network,
		...(filterStatus != null ? { status: filterStatus } : {}),
		...(searchQuery != null && searchQuery.trim() !== ''
			? {
					OR: [
						{ name: { contains: searchQuery, mode: 'insensitive' as const } },
						{ description: { contains: searchQuery, mode: 'insensitive' as const } },
						{ category: { contains: searchQuery, mode: 'insensitive' as const } },
						{ url: { contains: searchQuery, mode: 'insensitive' as const } },
						{ payTo: { contains: searchQuery, mode: 'insensitive' as const } },
						{ tags: { has: searchQuery } },
					],
				}
			: {}),
	};

	return prisma.simpleApiListing.findMany({
		where,
		orderBy: { createdAt: 'desc' },
		take: limit,
		...(cursorId != null ? { cursor: { id: cursorId }, skip: 1 } : {}),
	});
}

export async function countSimpleApiListings(params: { network: Network; filterStatus?: SimpleApiStatus }) {
	return prisma.simpleApiListing.count({
		where: {
			network: params.network,
			...(params.filterStatus != null ? { status: params.filterStatus } : {}),
		},
	});
}

interface QueryDiffParams {
	network: Network;
	statusUpdatedAfter: string;
	limit: number;
	cursorId?: string;
}

export async function getSimpleApiListingsDiff(params: QueryDiffParams) {
	const { network, statusUpdatedAfter, limit, cursorId } = params;

	const listings = await prisma.simpleApiListing.findMany({
		where: {
			network,
			statusUpdatedAt: { gt: new Date(statusUpdatedAfter) },
		},
		orderBy: [{ statusUpdatedAt: 'asc' }, { id: 'asc' }],
		take: limit,
		...(cursorId != null ? { cursor: { id: cursorId }, skip: 1 } : {}),
	});

	const cursor = listings.length === limit ? (listings[listings.length - 1]?.id ?? null) : null;

	return { listings, cursor };
}
