import { z } from '@/utils/zod-openapi';
import { Network } from '@/generated/prisma/client';
import {
	createPaymentSchemaOutput,
	createPaymentsSchemaInput,
	queryPaymentCountSchemaInput,
	queryPaymentCountSchemaOutput,
	queryPaymentsSchemaInput,
	queryPaymentsSchemaOutput,
} from '@/routes/api/payments/schemas';
import { queryPaymentDiffSchemaInput } from '@/routes/api/payments/diff';
import {
	authorizePaymentRefundSchemaInput,
	authorizePaymentRefundSchemaOutput,
} from '@/routes/api/payments/authorize-refund';
import { submitPaymentResultSchemaInput, submitPaymentResultSchemaOutput } from '@/routes/api/payments/submit-result';
import {
	paymentErrorStateRecoverySchemaInput,
	paymentErrorStateRecoverySchemaOutput,
} from '@/routes/api/payments/error-state-recovery';
import { queryPurchaseCountSchemaInput, queryPurchaseCountSchemaOutput } from '@/routes/api/purchases/schemas';
import {
	purchaseErrorStateRecoverySchemaInput,
	purchaseErrorStateRecoverySchemaOutput,
} from '@/routes/api/purchases/error-state-recovery';
import { paymentSchemaOutputExample } from '@/routes/api/payments/examples';
import { type SwaggerRegistrarContext } from '../shared';

export function registerPaymentPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/payment',
		description: 'Gets the payment status. It needs to be created first with a POST request.',
		summary: 'Get information about a payment request. (READ access required)',
		tags: ['payment'],
		request: {
			query: queryPaymentsSchemaInput.openapi({
				example: {
					limit: 10,
					cursorId: 'cuid_v2_of_last_cursor_entry',
					network: Network.Preprod,
				},
			}),
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Payment status',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: queryPaymentsSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: {
									Payments: [{ ...paymentSchemaOutputExample, TransactionHistory: [] }],
								},
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
		method: 'get',
		path: '/payment/diff',
		description:
			'Returns payments that changed since the provided timestamp (combined next-action + on-chain-state/result).',
		summary: 'Diff payments by combined status timestamp (READ access required)',
		tags: ['payment'],
		request: {
			query: queryPaymentDiffSchemaInput.openapi({
				example: {
					limit: 10,
					cursorId: 'cuid_v2_of_last_cursor_entry',
					lastUpdate: new Date(1713636260).toISOString(),
					network: Network.Preprod,
					includeHistory: 'false',
				},
			}),
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Payment diff',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: queryPaymentsSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: {
									Payments: [{ ...paymentSchemaOutputExample, TransactionHistory: [] }],
								},
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
		method: 'get',
		path: '/payment/diff/next-action',
		description: 'Returns payments whose next action changed since lastUpdate.',
		summary: 'Diff payments by next-action timestamp (READ access required)',
		tags: ['payment'],
		request: {
			query: queryPaymentDiffSchemaInput.openapi({
				example: {
					limit: 10,
					cursorId: 'cuid_v2_of_last_cursor_entry',
					lastUpdate: new Date(1713636260).toISOString(),
					network: Network.Preprod,
					includeHistory: 'false',
				},
			}),
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Payment diff',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: queryPaymentsSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: {
									Payments: [{ ...paymentSchemaOutputExample, TransactionHistory: [] }],
								},
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
		method: 'get',
		path: '/payment/count',
		description: 'Gets the total count of payments.',
		summary: 'Get the total number of payments. (READ access required)',
		tags: ['payment'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryPaymentCountSchemaInput.openapi({
				example: {
					network: Network.Preprod,
					filterSmartContractAddress: null,
				},
			}),
		},
		responses: {
			200: {
				description: 'Total payments count',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: queryPaymentCountSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										total: 150,
									},
								},
							}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/purchase/count',
		description: 'Gets the total count of purchases.',
		summary: 'Get the total number of purchases. (READ access required)',
		tags: ['purchase'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryPurchaseCountSchemaInput.openapi({
				example: {
					network: Network.Preprod,
					filterSmartContractAddress: null,
				},
			}),
		},
		responses: {
			200: {
				description: 'Total purchases count',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: queryPurchaseCountSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										total: 75,
									},
								},
							}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/payment/diff/onchain-state-or-result',
		description: 'Returns payments whose on-chain state or result hash changed since lastUpdate.',
		summary: 'Diff payments by on-chain-state/result timestamp (READ access required)',
		tags: ['payment'],
		request: {
			query: queryPaymentDiffSchemaInput.openapi({
				example: {
					limit: 10,
					cursorId: 'cuid_v2_of_last_cursor_entry',
					lastUpdate: new Date(1713636260).toISOString(),
					network: Network.Preprod,
					includeHistory: 'false',
				},
			}),
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Payment diff',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: queryPaymentsSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: {
									Payments: [{ ...paymentSchemaOutputExample, TransactionHistory: [] }],
								},
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
		path: '/payment',
		description: 'Creates a payment request and identifier. This will check incoming payments in the background.',
		summary: 'Create a new payment request. (+PAY access required)',
		tags: ['payment'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: createPaymentsSchemaInput.openapi({
							example: {
								agentIdentifier: 'agent_identifier',
								network: Network.Preprod,
								inputHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
								payByTime: new Date(1713626260).toISOString(),
								metadata: '(private) metadata to be stored with the payment request',
								submitResultTime: new Date(1713636260).toISOString(),
								identifierFromPurchaser: 'aabbaabb11221122aabb',
							},
						}),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Payment request created',
				content: {
					'application/json': {
						schema: z.object({ data: createPaymentSchemaOutput, status: z.string() }).openapi({
							example: {
								status: 'Success',
								data: paymentSchemaOutputExample,
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
		path: '/payment/submit-result',
		description:
			'Submit the hash of their completed job for a payment request, which triggers the fund unlock process so the seller can collect payment after the unlock time expires. (+PAY access required; only the creator or an admin may submit)',
		summary:
			'Completes a payment request. This will collect the funds after the unlock time. (+PAY access required; only the creator or an admin may submit)',
		tags: ['payment'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: submitPaymentResultSchemaInput.openapi({
							example: {
								network: Network.Preprod,
								blockchainIdentifier: 'identifier',
								submitResultHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
							},
						}),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Payment updated',
				content: {
					'application/json': {
						schema: z
							.object({
								data: submitPaymentResultSchemaOutput,
								status: z.string(),
							})
							.openapi({
								example: {
									status: 'Success',
									data: paymentSchemaOutputExample,
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
			403: {
				description: 'Forbidden (only the creator or an admin can submit results)',
			},
			404: {
				description: 'Payment not found or in invalid state',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/payment/authorize-refund',
		description:
			'Authorizes a refund for a payment request. This will stop the right to receive a payment and initiate a refund for the other party. (+PAY access required; only the creator or an admin may authorize)',
		summary:
			'Authorizes a refund for a payment request. This will stop the right to receive a payment and initiate a refund for the other party. (+PAY access required; only the creator or an admin may authorize)',
		tags: ['payment'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: authorizePaymentRefundSchemaInput.openapi({
							example: {
								network: Network.Preprod,
								blockchainIdentifier: 'blockchain_identifier',
							},
						}),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Payment refund authorized',
				content: {
					'application/json': {
						schema: z
							.object({
								data: authorizePaymentRefundSchemaOutput,
								status: z.string(),
							})
							.openapi({
								example: {
									status: 'Success',
									data: paymentSchemaOutputExample,
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
			403: {
				description: 'Forbidden (only the creator or an admin can authorize a refund)',
			},
			404: {
				description: 'Payment not found or in invalid state',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/payment/error-state-recovery',
		description:
			'Clears error states for payment requests in WaitingForManualAction state and resets them up for retry or other actions. This endpoint provides manual intervention capability to recover from error states by clearing error fields.',
		summary: 'Clear error state for payment request (PAY access required)',
		tags: ['error-state-recovery'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Payment error recovery request details',
				content: {
					'application/json': {
						schema: paymentErrorStateRecoverySchemaInput.openapi({
							example: {
								blockchainIdentifier: 'blockchain_identifier',
								updatedAt: new Date(1713636260).toISOString(),
								network: Network.Preprod,
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Error state cleared successfully for payment request',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: paymentErrorStateRecoverySchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										id: 'cmf40vg7h0016ucj1u1ro6651',
									},
								},
							}),
					},
				},
			},
			400: {
				description: 'Bad Request (not in WaitingForManualAction state, no error to clear, or invalid input)',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							error: z.object({ message: z.string() }),
						}),
						example: {
							status: 'error',
							error: {
								message:
									'Payment request is not in WaitingForManualAction state. Current state: WaitingForExternalAction',
							},
						},
					},
				},
			},
			401: {
				description: 'Unauthorized',
			},
			404: {
				description: 'Payment request not found',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							error: z.object({ message: z.string() }),
						}),
						example: {
							status: 'error',
							error: { message: 'Payment request not found' },
						},
					},
				},
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/purchase/error-state-recovery',
		description:
			'Clears error states for purchase requests in WaitingForManualAction state and resets them up for retry or other actions. This endpoint provides manual intervention capability to recover from error states by clearing error fields.',
		summary: 'Clear error state for purchase request (PAY access required)',
		tags: ['error-state-recovery'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Purchase error recovery request details',
				content: {
					'application/json': {
						schema: purchaseErrorStateRecoverySchemaInput.openapi({
							example: {
								blockchainIdentifier: 'blockchain_identifier',
								network: Network.Preprod,
								updatedAt: new Date(1713636260).toISOString(),
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Error state cleared successfully for purchase request',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: purchaseErrorStateRecoverySchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										id: 'cmf40vg7h0016ucj1u1ro6651',
									},
								},
							}),
					},
				},
			},
			400: {
				description: 'Bad Request (not in WaitingForManualAction state, no error to clear, or invalid input)',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							error: z.object({ message: z.string() }),
						}),
						example: {
							status: 'error',
							error: {
								message:
									'Purchase request is not in WaitingForManualAction state. Current state: WaitingForExternalAction',
							},
						},
					},
				},
			},
			401: {
				description: 'Unauthorized',
			},
			404: {
				description: 'Purchase request not found',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							error: z.object({ message: z.string() }),
						}),
						example: {
							status: 'error',
							error: { message: 'Purchase request not found' },
						},
					},
				},
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});
}
