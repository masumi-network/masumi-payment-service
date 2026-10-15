// OpenAPI docs for wallet fund transfers and consolidation.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import {
	postWalletFundSchemaInput,
	postWalletFundSchemaOutput,
	getWalletFundSchemaInput,
	getWalletFundSchemaOutput,
	postWalletConsolidateSchemaInput,
	postWalletConsolidateSchemaOutput,
} from './schemas';
import { fundTransferExample, postWalletFundBodyExample, getWalletFundQueryExample } from './examples';

export function registerWalletTransferPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'post',
		path: '/wallet/transfer-funds',
		description:
			'Queues an asynchronous transfer of lovelace (and optional native assets) from a hot wallet to a target Cardano address. The transfer is picked up by the background processor once the wallet is free. Poll GET /wallet/transfer-funds to check status.',
		summary: 'Queue a fund transfer from a wallet. (admin access required)',
		tags: ['wallet'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Fund transfer request',
				content: {
					'application/json': {
						schema: postWalletFundSchemaInput.openapi({ example: postWalletFundBodyExample }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Fund transfer queued', postWalletFundSchemaOutput, fundTransferExample),
			400: {
				description: 'Bad Request (lovelaceAmount below 2 ADA minimum)',
			},
			404: {
				description: 'Not Found (wallet not found)',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/wallet/consolidate',
		description:
			"Merges a hot wallet's L1 UTxOs by queuing a fund transfer back to the wallet itself. The amount is the whole balance less 2 ADA, which pays the fee and becomes the change output, so the transfer spends nearly every UTxO and leaves about two. Runs through the same background processor as any transfer: poll GET /wallet/transfer-funds with the returned id.",
		summary: "Merge a wallet's UTxOs. (admin access required)",
		tags: ['wallet'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Consolidation request',
				content: {
					'application/json': {
						schema: postWalletConsolidateSchemaInput.openapi({ example: { walletAddress: 'addr_test1...' } }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Consolidation queued', postWalletConsolidateSchemaOutput, fundTransferExample),
			400: {
				description:
					'Bad Request (fewer than two UTxOs, under 4 ADA in the wallet, over 150 UTxOs, or over 40 distinct assets)',
			},
			404: { description: 'Not Found (wallet not found)' },
			409: { description: 'Conflict (the wallet is mid-transaction, or a fund transfer from it is still pending)' },
			502: { description: 'Bad Gateway (the chain provider could not list the wallet UTxOs)' },
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/wallet/transfer-funds',
		description:
			'Query the status of a fund transfer by id, or list all fund transfers for a wallet. Poll this endpoint after posting to /wallet/transfer-funds. Status values: Pending (queued or submitted), Confirmed (on-chain), FailedViaManualReset (submission error), FailedViaTimeout (no confirmation within timeout).',
		summary: 'Get fund transfer status or history. (admin access required)',
		tags: ['wallet'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: getWalletFundSchemaInput.openapi({ example: getWalletFundQueryExample }),
		},
		responses: {
			200: successResponse('Fund transfer list', getWalletFundSchemaOutput, {
				transfers: [fundTransferExample],
			}),
			404: {
				description: 'Fund transfer not found',
			},
		},
	});
}
