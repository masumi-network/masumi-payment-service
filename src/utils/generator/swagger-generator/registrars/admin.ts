import { z } from '@/utils/zod-openapi';
import { healthResponseSchema } from '@/routes/api/health/schemas';
import {
	addAPIKeySchemaInput,
	addAPIKeySchemaOutput,
	apiKeyOutputSchema,
	deleteAPIKeySchemaInput,
	deleteAPIKeySchemaOutput,
	getAPIKeySchemaInput,
	getAPIKeySchemaOutput,
	updateAPIKeySchemaInput,
	updateAPIKeySchemaOutput,
} from '@/routes/api/api-key/schemas';
import {
	postWalletSchemaInput,
	postWalletSchemaOutput,
	getWalletSchemaInput,
	getWalletSchemaOutput,
	patchWalletSchemaInput,
	patchWalletSchemaOutput,
	postWalletFundSchemaInput,
	postWalletFundSchemaOutput,
	getWalletFundSchemaInput,
	getWalletFundSchemaOutput,
} from '@/routes/api/wallet/schemas';
import {
	deleteWalletLowBalanceRuleSchemaInput,
	deleteWalletLowBalanceRuleSchemaOutput,
	getWalletLowBalanceRulesSchemaInput,
	getWalletLowBalanceRulesSchemaOutput,
	patchWalletLowBalanceRuleSchemaInput,
	patchWalletLowBalanceRuleSchemaOutput,
	postWalletLowBalanceRuleSchemaInput,
	postWalletLowBalanceRuleSchemaOutput,
} from '@/routes/api/wallet/low-balance';
import { postRevealDataSchemaOutput, postVerifyDataRevealSchemaInput } from '@/routes/api/signature/verify/reveal-data';
import {
	swapTokensSchemaInput,
	swapTokensSchemaOutput,
	getSwapConfirmSchemaInput,
	getSwapConfirmSchemaOutput,
	getSwapTransactionsSchemaInput,
	getSwapTransactionsSchemaOutput,
	getSwapEstimateSchemaInput,
	getSwapEstimateSchemaOutput,
	cancelSwapSchemaInput,
	cancelSwapSchemaOutput,
	acknowledgeSwapTimeoutSchemaInput,
	acknowledgeSwapTimeoutSchemaOutput,
} from '@/routes/api/swap/schemas';
import {
	apiKeyExample,
	addAPIKeyBodyExample,
	deleteAPIKeyBodyExample,
	deleteAPIKeyResponseExample,
	listAPIKeysQueryExample,
	updateAPIKeyBodyExample,
	updateAPIKeyResponseExample,
} from '@/routes/api/api-key/examples';
import {
	createWalletBodyExample,
	createWalletLowBalanceRuleBodyExample,
	createWalletResponseExample,
	deleteWalletLowBalanceRuleBodyExample,
	getWalletQueryExample,
	getWalletLowBalanceRulesQueryExample,
	updateWalletLowBalanceRuleBodyExample,
	updateWalletBodyExample,
	walletExample,
	walletLowBalanceRuleExample,
	fundTransferExample,
	postWalletFundBodyExample,
	getWalletFundQueryExample,
} from '@/routes/api/wallet/examples';
import { successResponse, type SwaggerRegistrarContext } from '../shared';

export function registerAdminPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/health',
		tags: ['health'],
		summary: 'Get the status of the API server. (No authentication required)',
		request: {},
		responses: {
			200: successResponse('Object with status ok, if the server is up and healthy', healthResponseSchema, {
				status: 'ok',
			}),
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/api-key-status',
		description: 'Gets api key status',
		summary: 'Get information about your current API key.',
		tags: ['api-key'],
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'API key status',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: apiKeyOutputSchema }).openapi({
							example: {
								status: 'Success',
								data: apiKeyExample,
							},
						}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/wallet',
		description: 'Gets wallet status',
		summary: 'Get information about a wallet. (admin access required)',
		tags: ['wallet'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: getWalletSchemaInput.openapi({ example: getWalletQueryExample }),
		},
		responses: {
			200: {
				description: 'Wallet status',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: getWalletSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: walletExample,
							},
						}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/wallet',
		description: 'Creates a wallet, it will not be saved in the database, please ensure to remember the mnemonic',
		summary: 'Create a new wallet. (admin access required)',
		tags: ['wallet'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: postWalletSchemaInput.openapi({ example: createWalletBodyExample }),
					},
				},
			},
		},
		responses: { 200: successResponse('Wallet created', postWalletSchemaOutput, createWalletResponseExample) },
	});

	registry.registerPath({
		method: 'patch',
		path: '/wallet',
		description: 'Updates a wallet',
		summary: 'Update a wallet. (admin access required)',
		tags: ['wallet'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: patchWalletSchemaInput.openapi({ example: updateWalletBodyExample }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Wallet updated', patchWalletSchemaOutput, walletExample),
			404: {
				description: 'Wallet not found',
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/wallet/low-balance',
		description: 'Lists low-balance monitoring rules for wallets',
		summary: 'List wallet low-balance rules. (read access required)',
		tags: ['wallet'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: getWalletLowBalanceRulesSchemaInput.openapi({ example: getWalletLowBalanceRulesQueryExample }),
		},
		responses: {
			200: successResponse('Wallet low-balance rules', getWalletLowBalanceRulesSchemaOutput, {
				Rules: [walletLowBalanceRuleExample],
			}),
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/wallet/low-balance',
		description: 'Creates a wallet low-balance monitoring rule',
		summary: 'Create a wallet low-balance rule. (admin access required)',
		tags: ['wallet'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Low-balance rule to create',
				content: {
					'application/json': {
						schema: postWalletLowBalanceRuleSchemaInput.openapi({
							example: createWalletLowBalanceRuleBodyExample,
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse(
				'Wallet low-balance rule created',
				postWalletLowBalanceRuleSchemaOutput,
				walletLowBalanceRuleExample,
			),
			404: {
				description: 'Wallet not found',
			},
			409: {
				description: 'Low-balance rule already exists for this wallet and asset',
			},
		},
	});

	registry.registerPath({
		method: 'patch',
		path: '/wallet/low-balance',
		description: 'Updates a wallet low-balance monitoring rule',
		summary: 'Update a wallet low-balance rule. (admin access required)',
		tags: ['wallet'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Low-balance rule update',
				content: {
					'application/json': {
						schema: patchWalletLowBalanceRuleSchemaInput.openapi({
							example: updateWalletLowBalanceRuleBodyExample,
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Wallet low-balance rule updated', patchWalletLowBalanceRuleSchemaOutput, {
				...walletLowBalanceRuleExample,
				thresholdAmount: '7000000',
			}),
			404: {
				description: 'Low-balance rule not found',
			},
		},
	});

	registry.registerPath({
		method: 'delete',
		path: '/wallet/low-balance',
		description: 'Deletes a wallet low-balance monitoring rule',
		summary: 'Delete a wallet low-balance rule. (admin access required)',
		tags: ['wallet'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Low-balance rule to delete',
				content: {
					'application/json': {
						schema: deleteWalletLowBalanceRuleSchemaInput.openapi({
							example: deleteWalletLowBalanceRuleBodyExample,
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Wallet low-balance rule deleted', deleteWalletLowBalanceRuleSchemaOutput, {
				ruleId: 'low_balance_rule_id',
				deletedAt: new Date(1713636260),
			}),
			404: {
				description: 'Low-balance rule not found',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/signature/verify/reveal-data',
		description: 'Verifies the reveal data signature is valid.',
		summary: 'Verifies the reveal data signature is valid. (read access required)',
		tags: ['signature'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: postVerifyDataRevealSchemaInput.openapi({
							example: {
								action: 'RevealData',
								blockchainIdentifier: 'blockchain_identifier',
								signature: 'signature',
								key: 'key',
								walletAddress: 'wallet_address',
								validUntil: 1713636260,
							},
						}),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: successResponse('Revealed data', postRevealDataSchemaOutput, {
				isValid: true,
			}),
			400: {
				description: 'Bad Request (invalid signature or payment is not disputable)',
			},
			401: {
				description: 'Unauthorized',
			},
			403: {
				description: 'Forbidden (network not allowed)',
			},
			404: {
				description: 'Payment not found',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/api-key',
		description: 'Gets api key status',
		summary: 'Get information about all API keys. (admin access required)',
		tags: ['api-key'],
		request: {
			query: getAPIKeySchemaInput.openapi({ example: listAPIKeysQueryExample }),
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Api key status',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: getAPIKeySchemaOutput }).openapi({
							example: {
								data: {
									ApiKeys: [apiKeyExample],
								},
								status: 'Success',
							},
						}),
					},
				},
			},
			400: {
				description: 'Bad Request (possible parameters missing or invalid)',
			},
			401: {
				description: 'Unauthorized',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/swap',
		description:
			'Swap ADA for CNTs (Cardano Native Tokens) or CNTs for ADA using SundaeSwap DEX. This endpoint is mainnet-only.',
		summary: 'Execute a token swap on SundaeSwap. (admin access required, mainnet only)',
		tags: ['swap'],
		request: {
			body: {
				description: 'Swap request parameters',
				content: {
					'application/json': {
						schema: swapTokensSchemaInput.openapi({
							example: {
								walletVkey: 'wallet_verification_key_here',
								amount: 1,
								FromToken: {
									policyId: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
									assetName: '5553444d',
									name: 'USDM',
								},
								ToToken: {
									policyId: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
									assetName: '5553444d',
									name: 'USDM',
								},
								poolId: '64f35d26b237ad58e099041bc14c687ea7fdc58969d7d5b66e2540ef',
								slippage: 0.03,
							},
						}),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Swap executed successfully',
				content: {
					'application/json': {
						schema: swapTokensSchemaOutput.openapi({
							example: {
								txHash: 'abc123def456...',
								walletAddress: 'addr1...',
							},
						}),
					},
				},
			},
			400: {
				description: 'Bad Request (missing or invalid parameters)',
			},
			401: {
				description: 'Unauthorized (invalid API key or insufficient permissions)',
			},
			500: {
				description: 'Internal Server Error (swap failed)',
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/swap/confirm',
		description:
			'Check on-chain confirmation status of a swap transaction by transaction hash. Use after POST /swap/ to poll until status is confirmed. Mainnet only.',
		summary: 'Get swap transaction confirmation status. (admin access required, mainnet only)',
		tags: ['swap'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: getSwapConfirmSchemaInput.openapi({
				example: {
					txHash: 'abc123def456...',
					walletVkey: 'wallet_verification_key_here',
				},
			}),
		},
		responses: {
			200: {
				description: 'Confirmation status (Pending, Confirmed, or NotFound)',
				content: {
					'application/json': {
						schema: getSwapConfirmSchemaOutput.openapi({
							example: {
								status: 'Confirmed',
								swapStatus: 'OrderConfirmed',
								confirmations: 15,
							},
						}),
					},
				},
			},
			400: {
				description: 'Bad Request (e.g. mainnet wallet required)',
			},
			401: {
				description: 'Unauthorized',
			},
			404: {
				description: 'Wallet not found',
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/swap/transactions',
		description: 'List swap transactions for a wallet, ordered by most recent first. Supports cursor-based pagination.',
		summary: 'List swap transactions. (admin access required, mainnet only)',
		tags: ['swap'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: getSwapTransactionsSchemaInput.openapi({
				example: {
					walletVkey: 'wallet_verification_key_here',
					limit: 10,
				},
			}),
		},
		responses: {
			200: {
				description: 'List of swap transactions',
				content: {
					'application/json': {
						schema: getSwapTransactionsSchemaOutput.openapi({
							example: {
								SwapTransactions: [
									{
										id: 'clx1abc...',
										createdAt: '2026-03-06T12:00:00.000Z',
										txHash: 'abc123def456...',
										status: 'Confirmed',
										swapStatus: 'Completed',
										confirmations: 15,
										fromPolicyId: '',
										fromAssetName: '',
										fromAmount: '10',
										toPolicyId: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
										toAssetName: '0014df105553444d',
										poolId: 'pool_id_here',
										slippage: 0.03,
										cancelTxHash: null,
										orderOutputIndex: null,
									},
								],
							},
						}),
					},
				},
			},
			401: {
				description: 'Unauthorized',
			},
			404: {
				description: 'Wallet not found',
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/swap/estimate',
		description:
			'Get a swap price estimate from the SundaeSwap pool. Returns the conversion rate based on current pool reserves.',
		summary: 'Get swap price estimate. (admin access required, mainnet only)',
		tags: ['swap'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: getSwapEstimateSchemaInput.openapi({
				example: {
					fromPolicyId: '',
					fromAssetName: '',
					toPolicyId: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
					toAssetName: '0014df105553444d',
					poolId: 'pool_id_here',
				},
			}),
		},
		responses: {
			200: {
				description: 'Swap estimate',
				content: {
					'application/json': {
						schema: getSwapEstimateSchemaOutput.openapi({
							example: {
								rate: 2.45,
								fee: 0.003,
								fromDecimals: 6,
								toDecimals: 6,
							},
						}),
					},
				},
			},
			400: {
				description: 'Bad request (invalid pool or token)',
			},
			401: {
				description: 'Unauthorized',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/swap/cancel',
		description:
			'Cancel a pending SundaeSwap order that is sitting at the script address. Only orders in OrderConfirmed state can be cancelled.',
		summary: 'Cancel a pending swap order. (admin access required, mainnet only)',
		tags: ['swap'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Cancel swap request parameters',
				content: {
					'application/json': {
						schema: cancelSwapSchemaInput.openapi({
							example: {
								walletVkey: 'wallet_verification_key_here',
								swapTransactionId: 'clx1abc...',
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Cancel transaction submitted',
				content: {
					'application/json': {
						schema: cancelSwapSchemaOutput.openapi({
							example: {
								cancelTxHash: 'abc123def456...',
							},
						}),
					},
				},
			},
			400: {
				description: 'Bad Request (swap not in cancellable state)',
			},
			401: {
				description: 'Unauthorized',
			},
			404: {
				description: 'Swap transaction or wallet not found',
			},
			409: {
				description: 'Wallet is currently locked',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/swap/acknowledge-timeout',
		description:
			'Acknowledge a timed-out swap transaction. Checks on-chain state and recovers to the correct status: OrderConfirmed if the order UTXO still exists (allowing retry), Completed if the DEX executed the swap, or keeps the timeout state if the order tx never confirmed.',
		summary: 'Acknowledge a swap timeout and recover state. (admin access required, mainnet only)',
		tags: ['swap'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Acknowledge timeout request parameters',
				content: {
					'application/json': {
						schema: acknowledgeSwapTimeoutSchemaInput.openapi({
							example: {
								walletVkey: 'wallet_verification_key_here',
								swapTransactionId: 'clx1abc...',
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Timeout acknowledged, state recovered',
				content: {
					'application/json': {
						schema: acknowledgeSwapTimeoutSchemaOutput.openapi({
							example: {
								swapStatus: 'OrderConfirmed',
								message: 'Cancel tx failed but order UTXO still exists. You can retry cancelling.',
							},
						}),
					},
				},
			},
			400: {
				description: 'Bad Request (swap not in timeout state)',
			},
			401: {
				description: 'Unauthorized',
			},
			404: {
				description: 'Swap transaction or wallet not found',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/api-key',
		description: 'Creates a API key',
		summary: 'Create a new API key. (admin access required)',
		tags: ['api-key'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: addAPIKeySchemaInput.openapi({ example: addAPIKeyBodyExample }),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'API key created',
				content: {
					'application/json': {
						schema: z.object({ data: addAPIKeySchemaOutput, status: z.string() }).openapi({
							example: {
								status: 'Success',
								data: apiKeyExample,
							},
						}),
					},
				},
			},
			400: {
				description: 'Bad Request (possible parameters missing or invalid)',
			},
			401: {
				description: 'Unauthorized',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'patch',
		path: '/api-key',
		description: 'Creates a API key',
		summary: 'Update an existing API key. (admin access required)',
		tags: ['api-key'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: updateAPIKeySchemaInput.openapi({ example: updateAPIKeyBodyExample }),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'API key updated',
				content: {
					'application/json': {
						schema: z.object({ data: updateAPIKeySchemaOutput, status: z.string() }).openapi({
							example: {
								status: 'Success',
								data: updateAPIKeyResponseExample,
							},
						}),
					},
				},
			},
			400: {
				description: 'Bad Request (possible parameters missing or invalid)',
			},
			401: {
				description: 'Unauthorized',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

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

	registry.registerPath({
		method: 'delete',
		path: '/api-key',
		description: 'Removes a API key',
		summary: 'Delete an existing API key. (admin access required)',
		tags: ['api-key'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: deleteAPIKeySchemaInput.openapi({ example: deleteAPIKeyBodyExample }),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'API key deleted',
				content: {
					'application/json': {
						schema: z.object({ data: deleteAPIKeySchemaOutput, status: z.string() }).openapi({
							example: {
								status: 'Success',
								data: deleteAPIKeyResponseExample,
							},
						}),
					},
				},
			},
			400: {
				description: 'Bad Request (possible parameters missing or invalid)',
			},
			401: {
				description: 'Unauthorized',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});
}
