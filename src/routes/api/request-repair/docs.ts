// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR — CI regenerates
// openapi-docs.json and fails on drift.
import {
	previewRepairRequestSchemaInput,
	previewRepairRequestSchemaOutput,
	repairRequestSchemaInput,
	repairRequestSchemaOutput,
} from '@/routes/api/request-repair';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

const repairBodyExample = {
	kind: 'Purchase',
	network: 'Preprod',
	blockchainIdentifier: 'blockchain_identifier',
	txHash: '0000000000000000000000000000000000000000000000000000000000000000',
};

const requestVersionExample = 'yF6hS5jPq0yNlTTDyc7mwHt18ZMYbn1RGv5C49VqX74';

export function registerRequestRepairPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];

	registry.registerPath({
		method: 'post',
		path: '/request-repair/preview',
		description:
			'Dry run of a repair: validates the contract version, confirmation depth, unspent output and immutable request fields, then reports what would change without writing. Pass the returned requestVersion to apply; apply returns 409 if tx-sync changes the request after preview. A failed transaction check returns 400; an inconclusive chain-provider lookup returns 502.',
		summary: 'Preview a manual request repair. (admin access required)',
		tags: ['request-repair'],
		security: secured,
		request: {
			body: {
				description: 'Request and transaction to validate',
				content: {
					'application/json': {
						schema: previewRepairRequestSchemaInput.openapi({ example: repairBodyExample }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Repair preview', previewRepairRequestSchemaOutput, {
				txHash: repairBodyExample.txHash,
				outputIndex: 0,
				derivedOnChainState: 'FundsLocked',
				resultHash: null,
				currentOnChainState: null,
				requestVersion: requestVersionExample,
			}),
			400: { description: 'The transaction does not validate against this request' },
			401: { description: 'Unauthorized' },
			404: { description: 'Request not found for the given blockchainIdentifier and network' },
			502: { description: 'Chain provider could not complete validation; retry later' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/request-repair',
		description:
			"Repoints a purchase or payment at a specific transaction and syncs its on-chain state. By default the transaction is fetched, checked for confirmation depth and a unique unspent output at this payment source's contract address, then its versioned datum and immutable fields are matched against the request. Pass requestVersion from preview so a concurrent tx-sync update returns 409 instead of being overwritten. Force skips chain checks but still requires requestVersion or expectedRequestUpdatedAt from the operator dialog to prevent a stale forced write.",
		summary: 'Repair a request by repointing it at a transaction. (admin access required)',
		tags: ['request-repair'],
		security: secured,
		request: {
			body: {
				description: 'Request and transaction to repair with',
				content: {
					'application/json': {
						schema: repairRequestSchemaInput.openapi({
							example: { ...repairBodyExample, requestVersion: requestVersionExample },
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Request repaired', repairRequestSchemaOutput, {
				requestId: 'request_id',
				txHash: repairBodyExample.txHash,
				transactionId: 'transaction_id',
				previousOnChainState: null,
				newOnChainState: 'FundsLocked',
				forced: false,
			}),
			400: { description: 'The transaction does not validate against this request' },
			401: { description: 'Unauthorized' },
			404: { description: 'Request not found for the given blockchainIdentifier and network' },
			409: { description: 'Request changed after preview or after the force dialog loaded' },
			502: { description: 'Chain provider could not complete validation; retry later' },
		},
	});
}
