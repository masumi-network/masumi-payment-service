import { Network, SimpleApiStatus } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';

const acceptEntrySchema = z
	.object({
		scheme: z.string().describe('Payment scheme (e.g. exact)'),
		network: z.string().describe('x402 chain (e.g. base-sepolia)'),
		maxAmountRequired: z.string().describe('Maximum payment amount in token base units'),
		payTo: z.string().describe('EVM address to pay'),
		asset: z.string().describe('EVM token contract address'),
		resource: z.string().describe('API resource URL'),
		description: z.string().nullable().describe('Description of this payment option'),
		mimeType: z.string().nullable().describe('MIME type of the resource response'),
	})
	.openapi('SimpleApiAcceptEntry');

export const simpleApiListingSchema = z
	.object({
		id: z.string().describe('Local listing ID'),
		registryListingId: z.string().describe('Registry-assigned listing ID'),
		entryType: z.literal('SimpleApi'),
		network: z.nativeEnum(Network).describe('Cardano network grouping (Preprod or Mainnet)'),
		name: z.string().describe('Name of the SimpleApi service'),
		description: z.string().nullable().describe('Description of the service'),
		url: z.string().describe('Base URL of the service'),
		category: z.string().nullable().describe('Category of the service'),
		tags: z.array(z.string()).describe('Tags for the service'),
		httpMethod: z.string().nullable().describe('HTTP method used to call the service'),
		status: z.nativeEnum(SimpleApiStatus).describe('Current availability status'),
		accepts: z.array(acceptEntrySchema).describe('Payment options accepted by this service'),
		extra: z.record(z.string(), z.unknown()).nullable().describe('Additional metadata'),
		lastActiveAt: z.string().datetime().nullable().describe('Last time the service was seen Online'),
		statusUpdatedAt: z.string().datetime().describe('Last time the status changed'),
		createdAt: z.string().datetime().describe('When this record was first synced'),
		updatedAt: z.string().datetime().describe('When this record was last updated'),
	})
	.openapi('SimpleApiListing');

export const querySimpleApiListingSchemaInput = z.object({
	limit: z.coerce.number().min(1).max(100).default(10).describe('Number of listings to return'),
	cursorId: z.string().optional().describe('Cursor for pagination'),
	network: z.nativeEnum(Network).describe('Cardano network grouping'),
	filterStatus: z.nativeEnum(SimpleApiStatus).optional().describe('Filter by listing status'),
	searchQuery: z
		.string()
		.max(200)
		.optional()
		.describe('Search query to filter by name, description, category, tags, URL, or payTo address'),
});

export const querySimpleApiListingSchemaOutput = z.object({
	SimpleApiListings: z.array(simpleApiListingSchema),
});

export const querySimpleApiCountSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('Cardano network grouping'),
	filterStatus: z.nativeEnum(SimpleApiStatus).optional().describe('Filter by listing status'),
});

export const querySimpleApiCountSchemaOutput = z.object({
	total: z.number().describe('Total number of SimpleApi listings'),
});

export const querySimpleApiDiffSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('Cardano network grouping'),
	statusUpdatedAfter: z.string().datetime().describe('Return listings whose status changed after this ISO timestamp'),
	limit: z.coerce.number().min(1).max(100).default(100).describe('Number of listings to return'),
	cursorId: z.string().optional().describe('Cursor for pagination'),
});

export const querySimpleApiDiffSchemaOutput = z.object({
	SimpleApiListings: z.array(simpleApiListingSchema),
	cursor: z.string().nullable().describe('Cursor for the next page; null when no more pages'),
});

const eip3009AuthorizationSchema = z
	.object({
		from: z.string().describe('EVM address of the token sender'),
		to: z.string().describe('EVM address of the token recipient (must match listing payTo)'),
		value: z
			.string()
			.regex(/^\d+$/, 'value must be a non-negative integer string')
			.describe('Amount in token base units'),
		validAfter: z.string().describe('Authorization valid after this Unix timestamp (string)'),
		validBefore: z.string().describe('Authorization valid before this Unix timestamp (string)'),
		nonce: z.string().describe('EIP-3009 nonce (32-byte hex)'),
	})
	.openapi('Eip3009Authorization');

export const paySimpleApiSchemaInput = z.object({
	listingId: z.string().describe('Local SimpleApiListing ID'),
	paymentNetwork: z.string().min(1).describe('x402 chain to pay on (e.g. base-sepolia)'),
	authorization: eip3009AuthorizationSchema,
	signature: z.string().min(1).describe('EIP-3009 signature (hex)'),
});

export const paySimpleApiSchemaOutput = z.object({
	xPaymentHeader: z.string().describe('Value to set as the X-PAYMENT request header when calling the protected API'),
	paymentRecordId: z.string().describe('Local payment record ID for tracking'),
});

export const registerSimpleApiSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('Cardano network grouping (Preprod or Mainnet)'),
	url: z.string().url().max(500).describe('Base URL of the service (must return HTTP 402 or expose /services.json)'),
	name: z.string().min(1).max(250).describe('Display name of the service'),
	description: z.string().max(500).optional().describe('Optional description of the service'),
	category: z.string().max(100).optional().describe('Optional service category'),
	tags: z.array(z.string().max(100)).max(15).optional().describe('Optional tags (max 15)'),
});

export const registerSimpleApiSchemaOutput = z.object({
	listing: simpleApiListingSchema,
});
