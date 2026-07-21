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

export function registerRequestRepairPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];

	registry.registerPath({
		method: 'post',
		path: '/request-repair/preview',
		description:
			'Dry run of a repair: validates the transaction against the request and reports what would change, without writing anything. A failed check returns 400 with the specific reason it failed.',
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
			}),
			400: { description: 'The transaction does not validate against this request' },
			401: { description: 'Unauthorized' },
			404: { description: 'Request not found for the given blockchainIdentifier and network' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/request-repair',
		description:
			"Repoints a purchase or payment at a specific transaction and syncs its on-chain state. By default the transaction is fetched, confirmed to have an output at this payment source's contract address, its datum decoded and its blockchainIdentifier matched against the request — the resulting state comes from the datum, not from the caller. Passing force skips those checks and writes the supplied onChainState verbatim.",
		summary: 'Repair a request by repointing it at a transaction. (admin access required)',
		tags: ['request-repair'],
		security: secured,
		request: {
			body: {
				description: 'Request and transaction to repair with',
				content: {
					'application/json': {
						schema: repairRequestSchemaInput.openapi({ example: repairBodyExample }),
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
		},
	});
}
