import { z } from '@/utils/zod-openapi';
import { Network, SimpleApiStatus } from '@/generated/prisma/client';
import {
	querySimpleApiListingSchemaInput,
	querySimpleApiListingSchemaOutput,
	querySimpleApiCountSchemaInput,
	querySimpleApiCountSchemaOutput,
	querySimpleApiDiffSchemaInput,
	querySimpleApiDiffSchemaOutput,
	paySimpleApiSchemaInput,
	paySimpleApiSchemaOutput,
	registerSimpleApiSchemaInput,
	registerSimpleApiSchemaOutput,
} from '@/routes/api/simple-api/schemas';
import { type SwaggerRegistrarContext } from '../shared';

export function registerSimpleApiPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/simple-api',
		description:
			'Returns SimpleApi listings synced from the registry. Supports pagination, status filter, and full-text search.',
		summary: 'Query SimpleApi listings (READ access required)',
		tags: ['simple-api'],
		request: {
			query: querySimpleApiListingSchemaInput.openapi({
				example: {
					limit: 10,
					network: Network.Preprod,
					filterStatus: SimpleApiStatus.Online,
				},
			}),
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'List of SimpleApi listings',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: querySimpleApiListingSchemaOutput }).openapi({
							example: {
								status: 'success',
								data: { SimpleApiListings: [] },
							},
						}),
					},
				},
			},
			400: { description: 'Bad Request' },
			401: { description: 'Unauthorized' },
			500: { description: 'Internal Server Error' },
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/simple-api/count',
		description: 'Returns the total count of SimpleApi listings matching the given filters.',
		summary: 'Count SimpleApi listings (READ access required)',
		tags: ['simple-api'],
		request: {
			query: querySimpleApiCountSchemaInput.openapi({
				example: {
					network: Network.Preprod,
				},
			}),
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Count of SimpleApi listings',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: querySimpleApiCountSchemaOutput }).openapi({
							example: {
								status: 'success',
								data: { total: 0 },
							},
						}),
					},
				},
			},
			400: { description: 'Bad Request' },
			401: { description: 'Unauthorized' },
			500: { description: 'Internal Server Error' },
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/simple-api/diff',
		description: 'Returns SimpleApi listings whose status changed after the given timestamp (incremental sync).',
		summary: 'Diff SimpleApi listings by status timestamp (READ access required)',
		tags: ['simple-api'],
		request: {
			query: querySimpleApiDiffSchemaInput.openapi({
				example: {
					network: Network.Preprod,
					statusUpdatedAfter: '2024-01-01T00:00:00.000Z',
					limit: 100,
				},
			}),
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Changed SimpleApi listings',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: querySimpleApiDiffSchemaOutput }).openapi({
							example: {
								status: 'success',
								data: { SimpleApiListings: [], cursor: null },
							},
						}),
					},
				},
			},
			400: { description: 'Bad Request' },
			401: { description: 'Unauthorized' },
			500: { description: 'Internal Server Error' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/simple-api/pay',
		description:
			'Initiates an EVM x402 payment for a SimpleApi listing. Forwards the EIP-3009 signed authorization to the configured x402 facilitator and returns the X-PAYMENT header for use with the protected API.',
		summary: 'Pay for a SimpleApi service via x402 (ReadAndPay access required)',
		tags: ['simple-api'],
		request: {
			body: {
				content: {
					'application/json': {
						schema: paySimpleApiSchemaInput.openapi({
							example: {
								listingId: 'cm_listing_id',
								paymentNetwork: 'base-sepolia',
								authorization: {
									from: '0xABCDEF...',
									to: '0x123456...',
									value: '1000000',
									validAfter: '0',
									validBefore: '9999999999',
									nonce: '0x' + '0'.repeat(64),
								},
								signature: '0xabc...',
							},
						}),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Payment settled successfully',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: paySimpleApiSchemaOutput }).openapi({
							example: {
								status: 'success',
								data: {
									xPaymentHeader: 'x402-base64-encoded-header',
									paymentRecordId: 'cm_record_id',
								},
							},
						}),
					},
				},
			},
			400: { description: 'Bad Request (invalid listing, mismatched payTo, etc.)' },
			401: { description: 'Unauthorized' },
			404: { description: 'Listing not found' },
			502: { description: 'Facilitator unreachable or returned an error' },
			500: { description: 'Internal Server Error' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/simple-api/register',
		description:
			'Registers a new Simple API service with the registry. The registry validates that the URL returns a valid HTTP 402 response or exposes a /services.json manifest. Returns the newly created listing.',
		summary: 'Register a Simple API service (Admin access required)',
		tags: ['simple-api'],
		request: {
			body: {
				content: {
					'application/json': {
						schema: registerSimpleApiSchemaInput.openapi({
							example: {
								network: Network.Preprod,
								url: 'https://api.example.com/v1/chat',
								name: 'Example Chat API',
								description: 'An x402-gated LLM chat endpoint',
								category: 'Inference',
								tags: ['llm', 'chat'],
							},
						}),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Service registered successfully',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: registerSimpleApiSchemaOutput }).openapi({
							example: {
								status: 'success',
								data: { listing: {} },
							},
						}),
					},
				},
			},
			400: { description: 'Bad Request (invalid URL or validation failure from registry)' },
			401: { description: 'Unauthorized' },
			422: { description: 'URL did not return a valid HTTP 402 or /services.json manifest' },
			502: { description: 'Registry service unreachable' },
			503: { description: 'REGISTRY_SERVICE_URL not configured' },
			500: { description: 'Internal Server Error' },
		},
	});
}
