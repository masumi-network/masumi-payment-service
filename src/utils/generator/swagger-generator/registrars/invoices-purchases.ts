import { z } from '@/utils/zod-openapi';
import { Network, PaymentAction, PurchasingAction } from '@/generated/prisma/client';
import {
	postGenerateMonthlyInvoiceSchemaInput,
	postGenerateMonthlyInvoiceSchemaOutput,
	getMonthlyInvoiceListSchemaInput,
	getMonthlyInvoiceListSchemaOutput,
} from '@/routes/api/invoice/monthly/schemas';
import {
	postInternalGenerateMonthlyInvoiceSchemaInput,
	postInternalGenerateMonthlyInvoiceSchemaOutput,
} from '@/routes/api/invoice/monthly/internal';
import {
	getMissingInvoicePaymentsSchemaInput,
	getMissingInvoicePaymentsSchemaOutput,
} from '@/routes/api/invoice/monthly/missing';
import {
	postMonthlySignatureSchemaInput,
	postMonthlySignatureSchemaOutput,
} from '@/routes/api/signature/sign/create-invoice/monthly';
import { queryRegistryCountSchemaInput, queryRegistryCountSchemaOutput } from '@/routes/api/registry/schemas';
import {
	createPurchaseInitSchemaInput,
	createPurchaseInitSchemaOutput,
	queryPurchaseRequestSchemaInput,
	queryPurchaseRequestSchemaOutput,
} from '@/routes/api/purchases/schemas';
import { createX402PurchaseSchemaInput, createX402PurchaseSchemaOutput } from '@/routes/api/purchases/x402';
import {
	requestPurchaseRefundSchemaInput,
	requestPurchaseRefundSchemaOutput,
} from '@/routes/api/purchases/request-refund';
import {
	cancelPurchaseRefundRequestSchemaInput,
	cancelPurchaseRefundRequestSchemaOutput,
} from '@/routes/api/purchases/cancel-refund-request';
import {
	postPaymentRequestSchemaInput,
	postPaymentRequestSchemaOutput,
} from '@/routes/api/payments/resolve-blockchain-identifier';
import {
	postPurchaseRequestSchemaInput,
	postPurchaseRequestSchemaOutput,
} from '@/routes/api/purchases/resolve-blockchain-identifier';
import { purchaseResponseSchemaExample } from '@/routes/api/purchases/examples';
import { type SwaggerRegistrarContext } from '../shared';

export function registerInvoiceAndPurchasePaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'post',
		path: '/signature/sign/create-invoice/monthly',
		description:
			'Provides a signed message from the smart contract wallet to authorize monthly invoice retrieval for a buyer wallet. (+PAY access required)',
		summary: 'Get a signed message to request a monthly invoice. (+PAY access required)',
		tags: ['signature'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: postMonthlySignatureSchemaInput.openapi({
							example: {
								action: 'RetrieveMonthlyInvoices',
								buyerWalletVkey: 'buyer_wallet_vkey',
								month: '2025-09',
								Buyer: {
									country: 'DE',
									city: 'Berlin',
									zipCode: '10115',
									street: 'Buyer Str.',
									streetNumber: '2',
									email: 'buyer@example.com',
									phone: '+49 30 987654',
									name: 'Bob',
									companyName: null,
									vatNumber: null,
								},
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Monthly signature generated',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: postMonthlySignatureSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										signature: 'ed25519_signature',
										key: 'ed25519_key',
										walletAddress: 'addr1...',
										signatureData: '{"action":"RetrieveMonthlyInvoices","validUntil":1736352000000,"hash":"..."}',
									},
								},
							}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/invoice/monthly',
		description:
			'Generates an invoice PDF aggregating all payment requests for a buyer wallet within a month, using the end-of-month conversion rate. (+PAY access required)\n\n**BETA:** This invoice feature is in beta. Generated invoices should be reviewed manually or verified with a tax advisor before use. Use at your own discretion.',
		summary: 'Generate a monthly invoice PDF by buyer wallet vkey and month. (+PAY access required)',
		tags: ['invoice'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: postGenerateMonthlyInvoiceSchemaInput.openapi({
							example: {
								signature: 'ed25519_signature',
								key: 'ed25519_key',
								walletAddress:
									'addr1xk2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
								validUntil: 1736352000000,
								action: 'RetrieveMonthlyInvoices',
								buyerWalletVkey: 'buyer_wallet_vkey',
								month: '2025-09',
								invoiceCurrency: 'usd',
								CurrencyConversion: {
									'': 0.45,
									policyIdAssetHex: 1.23,
								},
								Invoice: {
									itemNamePrefix: 'Agent: ',
									title: 'Monthly Invoice',
									language: 'en-us',
									localizationFormat: 'en-us',
								},
								vatRate: 0.19,
								reverseCharge: false,
								forceRegenerate: false,
								Seller: {
									country: 'DE',
									city: 'Berlin',
									zipCode: '10115',
									street: 'Example Str.',
									streetNumber: '1',
									email: 'seller@example.com',
									phone: '+49 30 123456',
									name: 'Alice',
									companyName: 'Alice GmbH',
									vatNumber: 'DE123456789',
								},
								Buyer: {
									country: 'DE',
									city: 'Berlin',
									zipCode: '10115',
									street: 'Buyer Str.',
									streetNumber: '2',
									email: 'buyer@example.com',
									phone: '+49 30 987654',
									name: 'Bob',
									companyName: null,
									vatNumber: null,
								},
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Monthly invoice generated',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: postGenerateMonthlyInvoiceSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										invoice: 'BASE64_PDF_STRING',
										cancellationInvoice: 'BASE64_CANCELLATION_PDF_STRING_OR_UNDEFINED',
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
		path: '/registry/count',
		description: 'Gets the total count of AI agents.',
		summary: 'Get the total number of AI agents. (READ access required)',
		tags: ['registry'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryRegistryCountSchemaInput.openapi({
				example: {
					network: Network.Preprod,
					filterSmartContractAddress: null,
				},
			}),
		},
		responses: {
			200: {
				description: 'Total AI agents count',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: queryRegistryCountSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										total: 42,
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
		path: '/invoice/monthly',
		description:
			'Lists invoice summaries for a given month with pagination. Returns only the latest revision per invoice base. Pass invoiceBaseId to get all revisions for a specific invoice. (+PAY access required)\n\n**BETA:** This invoice feature is in beta. Generated invoices should be reviewed manually or verified with a tax advisor before use. Use at your own risk.',
		summary: 'List invoices for a month. (+Read access required)',
		tags: ['invoice'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: getMonthlyInvoiceListSchemaInput.openapi({
				example: {
					month: '2025-09',
					limit: 10,
				},
			}),
		},
		responses: {
			200: {
				description: 'List of invoice summaries',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: getMonthlyInvoiceListSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										Invoices: [
											{
												id: 'invoice_base_id',
												invoiceId: 'INV-0001',
												createdAt: '2025-09-30T23:59:59.000Z',
												revisionId: 'revision_id',
												revisionNumber: 0,
												revisionCount: 1,
												invoiceMonth: 9,
												invoiceYear: 2025,
												invoiceDate: '2025-09-30T00:00:00.000Z',
												currencyShortId: 'usd',
												sellerName: 'Alice',
												sellerCompanyName: 'Alice GmbH',
												buyerName: 'Bob',
												buyerCompanyName: null,
												isCancelled: false,
												cancellationReason: null,
												cancellationDate: null,
												cancellationId: null,
												itemCount: 3,
												netTotal: '150.00',
												vatTotal: '28.50',
												grossTotal: '178.50',
												CoveredPaymentRequestIds: ['payment_id_1', 'payment_id_2'],
												buyerWalletVkey: 'buyer_wallet_vkey',
												invoicePdf: 'BASE64_PDF_STRING',
												cancellationInvoicePdf: null,
											},
										],
									},
								},
							}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/invoice/monthly/internal',
		description:
			'Generates an invoice PDF aggregating all payment requests for a buyer wallet within a month, without requiring buyer wallet signature verification. (+PAY access required)\n\n**BETA:** This invoice feature is in beta. Generated invoices should be reviewed manually or verified with a tax advisor before use. Use at your own discretion.',
		summary: 'Generate a monthly invoice PDF without signature verification. (+PAY access required)',
		tags: ['invoice'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: postInternalGenerateMonthlyInvoiceSchemaInput.openapi({
							example: {
								buyerWalletVkey: 'buyer_wallet_vkey',
								month: '2025-09',
								invoiceCurrency: 'usd',
								CurrencyConversion: {
									'': 0.45,
									policyIdAssetHex: 1.23,
								},
								Invoice: {
									itemNamePrefix: 'Agent: ',
									title: 'Monthly Invoice',
									language: 'en-us',
									localizationFormat: 'en-us',
								},
								vatRate: 0.19,
								reverseCharge: false,
								forceRegenerate: false,
								Seller: {
									country: 'DE',
									city: 'Berlin',
									zipCode: '10115',
									street: 'Example Str.',
									streetNumber: '1',
									email: 'seller@example.com',
									phone: '+49 30 123456',
									name: 'Alice',
									companyName: 'Alice GmbH',
									vatNumber: 'DE123456789',
								},
								Buyer: {
									country: 'DE',
									city: 'Berlin',
									zipCode: '10115',
									street: 'Buyer Str.',
									streetNumber: '2',
									email: 'buyer@example.com',
									phone: '+49 30 987654',
									name: 'Bob',
									companyName: null,
									vatNumber: null,
								},
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Monthly invoice generated',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: postInternalGenerateMonthlyInvoiceSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										invoice: 'BASE64_PDF_STRING',
										cancellationInvoice: 'BASE64_CANCELLATION_PDF_STRING_OR_UNDEFINED',
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
		path: '/invoice/monthly/missing',
		description:
			'Finds billable payment requests that do not yet have an invoice for a given month. Only finalized payments are included: Withdrawn (seller completed work), ResultSubmitted past unlock time, or DisputedWithdrawn with seller funds. Payments still locked, pending refund, or in dispute are excluded. (+PAY access required)\n\n**BETA:** This invoice feature is in beta. Generated invoices should be reviewed manually or verified with a tax advisor before use. Use at your own discretion.',
		summary: 'List uninvoiced payments for a month. (+Read access required)',
		tags: ['invoice'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: getMissingInvoicePaymentsSchemaInput.openapi({
				example: {
					month: '2025-09',
					limit: 10,
				},
			}),
		},
		responses: {
			200: {
				description: 'List of uninvoiced billable payments',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: getMissingInvoicePaymentsSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										UninvoicedPayments: [
											{
												id: 'payment_request_id',
												blockchainIdentifier: 'blockchain_identifier',
												onChainState: 'Withdrawn',
												createdAt: '2025-09-15T10:00:00.000Z',
												buyerWalletVkey: 'buyer_wallet_vkey',
												buyerWalletAddress: 'addr1...',
												RequestedFunds: [{ unit: '', amount: '5000000' }],
											},
										],
									},
								},
							}),
					},
				},
			},
		},
	});

	const queryPurchaseDiffSchemaInputForDocs = z.object({
		limit: z.coerce.number().min(1).max(100).default(10).describe('The number of purchases to return'),
		cursorId: z
			.string()
			.optional()
			.describe(
				'Pagination cursor (purchase id). Used as tie-breaker when lastUpdate equals a purchase change timestamp',
			),
		lastUpdate: z
			.string()
			.optional()
			.default(new Date(0).toISOString())
			.describe('Return purchases whose selected status timestamp changed at/after this ISO timestamp'),
		network: z.nativeEnum(Network).describe('The network the purchases were made on'),
		filterSmartContractAddress: z
			.string()
			.optional()
			.nullable()
			.describe('The smart contract address of the payment source'),
		includeHistory: z
			.string()
			.optional()
			.default('false')
			.describe('Whether to include the full transaction and status history of the purchases'),
	});

	registry.registerPath({
		method: 'get',
		path: '/purchase',
		description: 'Gets the purchase status. It needs to be created first with a POST request.',
		summary: 'Get information about an existing purchase request. (READ access required)',
		tags: ['purchase'],
		request: {
			query: queryPurchaseRequestSchemaInput.openapi({
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
				description: 'Purchase status',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: queryPurchaseRequestSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										Purchases: [
											{
												id: 'cuid_v2_auto_generated',
												blockchainIdentifier: 'blockchain_identifier',
												agentIdentifier: 'agent_identifier',
												lastCheckedAt: null,
												onChainState: null,
												metadata: null,
												requestedById: 'requester_id',
												resultHash: '',
												cooldownTime: 0,
												payByTime: null,
												cooldownTimeOtherParty: 0,
												collateralReturnLovelace: null,
												inputHash: 'input_hash',
												NextAction: {
													requestedAction: PurchasingAction.FundsLockingRequested,
													errorType: null,
													errorNote: null,
												},
												createdAt: new Date(1713636260),
												updatedAt: new Date(1713636260),
												externalDisputeUnlockTime: (1713636260).toString(),
												submitResultTime: new Date(1713636260).toISOString(),
												unlockTime: (1713636260).toString(),
												PaidFunds: [],
												PaymentSource: {
													id: 'payment_source_id',
													network: Network.Preprod,
													policyId: 'policy_id',
													smartContractAddress: 'address',
												},
												SellerWallet: null,
												SmartContractWallet: null,
												CurrentTransaction: null,
												TransactionHistory: [],
												WithdrawnForSeller: [],
												WithdrawnForBuyer: [],
												totalBuyerCardanoFees: 0,
												totalSellerCardanoFees: 0,
												nextActionOrOnChainStateOrResultLastChangedAt: new Date(1713636260),
												nextActionLastChangedAt: new Date(1713636260),
												onChainStateOrResultLastChangedAt: new Date(1713636260),
											},
										],
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
		path: '/purchase/diff',
		description:
			'Returns purchases that changed since the provided timestamp (combined next-action + on-chain-state/result).',
		summary: 'Diff purchases by combined status timestamp (READ access required)',
		tags: ['purchase'],
		request: {
			query: queryPurchaseDiffSchemaInputForDocs.openapi({
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
				description: 'Purchase diff',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: queryPurchaseRequestSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										Purchases: [
											{
												id: 'cuid_v2_auto_generated',
												blockchainIdentifier: 'blockchain_identifier',
												agentIdentifier: 'agent_identifier',
												lastCheckedAt: null,
												onChainState: null,
												metadata: null,
												requestedById: 'requester_id',
												resultHash: '',
												cooldownTime: 0,
												payByTime: null,
												cooldownTimeOtherParty: 0,
												collateralReturnLovelace: null,
												inputHash: 'input_hash',
												NextAction: {
													requestedAction: PurchasingAction.FundsLockingRequested,
													errorType: null,
													errorNote: null,
												},
												createdAt: new Date(1713636260),
												updatedAt: new Date(1713636260),
												externalDisputeUnlockTime: (1713636260).toString(),
												submitResultTime: new Date(1713636260).toISOString(),
												unlockTime: (1713636260).toString(),
												PaidFunds: [],
												PaymentSource: {
													id: 'payment_source_id',
													network: Network.Preprod,
													policyId: 'policy_id',
													smartContractAddress: 'address',
												},
												SellerWallet: null,
												SmartContractWallet: null,
												CurrentTransaction: null,
												TransactionHistory: [],
												WithdrawnForSeller: [],
												WithdrawnForBuyer: [],
												totalBuyerCardanoFees: 0,
												totalSellerCardanoFees: 0,
												nextActionOrOnChainStateOrResultLastChangedAt: new Date(1713636260),
												nextActionLastChangedAt: new Date(1713636260),
												onChainStateOrResultLastChangedAt: new Date(1713636260),
											},
										],
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
		path: '/purchase/diff/next-action',
		description: 'Returns purchases whose next action changed since lastUpdate.',
		summary: 'Diff purchases by next-action timestamp (READ access required)',
		tags: ['purchase'],
		request: {
			query: queryPurchaseDiffSchemaInputForDocs.openapi({
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
				description: 'Purchase diff',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							data: queryPurchaseRequestSchemaOutput,
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
		path: '/purchase/diff/onchain-state-or-result',
		description: 'Returns purchases whose on-chain state or result hash changed since lastUpdate.',
		summary: 'Diff purchases by on-chain-state/result timestamp (READ access required)',
		tags: ['purchase'],
		request: {
			query: queryPurchaseDiffSchemaInputForDocs.openapi({
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
				description: 'Purchase diff',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							data: queryPurchaseRequestSchemaOutput,
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
		path: '/purchase',
		description: 'Creates a purchase and pays the seller. This requires funds to be available.',
		summary: 'Create a new purchase request and pay. (access required +PAY)',
		tags: ['purchase'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: createPurchaseInitSchemaInput.openapi({
							example: {
								identifierFromPurchaser: 'aabbaabb11221122aabb',
								network: Network.Preprod,
								sellerVkey: 'seller_vkey',
								blockchainIdentifier: 'blockchain_identifier',
								payByTime: (1713626260).toString(),
								submitResultTime: (1713636260).toString(),
								unlockTime: (1713636260).toString(),
								externalDisputeUnlockTime: (1713636260).toString(),
								agentIdentifier: 'agent_identifier',
								inputHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
							},
						}),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Purchase request created',
				content: {
					'application/json': {
						schema: z
							.object({
								data: createPurchaseInitSchemaOutput,
								status: z.string(),
							})
							.openapi({
								example: {
									status: 'Success',
									data: purchaseResponseSchemaExample,
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
			409: {
				description: 'Conflict (purchase request already exists)',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							error: z.object({ message: z.string() }),
							id: z.string(),
							object: createPurchaseInitSchemaOutput,
						}),
						example: {
							status: 'error',
							error: { message: 'Purchase request already exists' },
							id: 'cuid_v2_auto_generated',
							object: purchaseResponseSchemaExample,
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
		path: '/purchase/x402',
		description:
			'Creates a purchase using the x402 payment protocol. Returns an unsigned Cardano transaction CBOR that the buyer must sign with their external wallet and submit to the network.',
		summary: 'Create a new x402 purchase request and get an unsigned transaction. (+PAY access required)',
		tags: ['purchase'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: createX402PurchaseSchemaInput.openapi({
							example: {
								identifierFromPurchaser: 'aabbaabb11221122aabb',
								network: Network.Preprod,
								sellerVkey: 'seller_vkey',
								blockchainIdentifier: 'blockchain_identifier',
								payByTime: (1713626260).toString(),
								submitResultTime: (1713636260).toString(),
								unlockTime: (1713636260).toString(),
								externalDisputeUnlockTime: (1713636260).toString(),
								agentIdentifier: 'agent_identifier',
								inputHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
								buyerAddress: 'addr_test1qp...',
							},
						}),
					},
				},
			},
		},
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: {
				description: 'Purchase request created with unsigned transaction CBOR',
				content: {
					'application/json': {
						schema: z
							.object({
								data: createX402PurchaseSchemaOutput,
								status: z.string(),
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										...purchaseResponseSchemaExample,
										unsignedTxCbor: '84a500818258...',
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
			409: {
				description: 'Conflict (purchase request already exists)',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							error: z.object({ message: z.string() }),
							id: z.string(),
							object: createX402PurchaseSchemaOutput,
						}),
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
		path: '/purchase/request-refund',
		description: 'Requests a refund for a completed purchase. This will collect the refund after the refund time.',
		summary:
			'Request a refund for a completed purchase, which will be automatically collected after the refund time period expires. (+PAY access required)',
		tags: ['purchase'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: requestPurchaseRefundSchemaInput.openapi({
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
				description: 'Purchase refund requested',
				content: {
					'application/json': {
						schema: z
							.object({
								data: requestPurchaseRefundSchemaOutput,
								status: z.string(),
							})
							.openapi({
								example: {
									status: 'Success',
									data: purchaseResponseSchemaExample,
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
				description: 'Forbidden (only the creator or an admin can request a refund)',
			},
			404: {
				description: 'Purchase not found or not in valid state',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/purchase/cancel-refund-request',
		description: 'Cancels a previously requested refund for a completed purchase.',
		summary:
			'Cancel a previously requested refund for a purchase, reverting the transaction back to its normal processing state. (+PAY access required)',
		tags: ['purchase'],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: cancelPurchaseRefundRequestSchemaInput.openapi({
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
				description: 'Purchase refund request cancelled',
				content: {
					'application/json': {
						schema: z
							.object({
								data: cancelPurchaseRefundRequestSchemaOutput,
								status: z.string(),
							})
							.openapi({
								example: {
									status: 'Success',
									data: purchaseResponseSchemaExample,
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
				description: 'Forbidden (only the creator or an admin can cancel a refund request)',
			},
			404: {
				description: 'Purchase not found or in invalid state',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/payment/resolve-blockchain-identifier',
		description: 'Resolves a payment request by its blockchain identifier.',
		summary: 'Resolve a payment request by its blockchain identifier. (READ access required)',
		tags: ['payment'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: postPaymentRequestSchemaInput.openapi({
							example: {
								blockchainIdentifier: 'blockchain_identifier',
								network: Network.Preprod,
								includeHistory: 'false',
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Payment request resolved',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: postPaymentRequestSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										id: 'cuid_v2_auto_generated',
										createdAt: new Date(1713636260),
										updatedAt: new Date(1713636260),
										blockchainIdentifier: 'blockchain_identifier',
										agentIdentifier: 'agent_identifier',
										lastCheckedAt: null,
										payByTime: null,
										submitResultTime: '0',
										unlockTime: '0',
										externalDisputeUnlockTime: '0',
										requestedById: 'requester_id',
										resultHash: 'result_hash',
										inputHash: 'input_hash',
										cooldownTime: 0,
										cooldownTimeOtherParty: 0,
										collateralReturnLovelace: null,
										onChainState: null,
										NextAction: {
											requestedAction: PaymentAction.WaitingForExternalAction,
											errorType: null,
											errorNote: null,
											resultHash: null,
										},
										CurrentTransaction: null,
										TransactionHistory: [],
										RequestedFunds: [
											{
												unit: '',
												amount: '10000000',
											},
										],
										PaymentSource: {
											id: 'payment_source_id',
											network: Network.Preprod,
											smartContractAddress: 'address',
											policyId: 'policy_id',
										},
										BuyerWallet: null,
										SmartContractWallet: null,
										metadata: null,
										WithdrawnForSeller: [],
										WithdrawnForBuyer: [],
										totalBuyerCardanoFees: 0,
										totalSellerCardanoFees: 0,
										nextActionLastChangedAt: new Date(1713636260),
										onChainStateOrResultLastChangedAt: new Date(1713636260),
										nextActionOrOnChainStateOrResultLastChangedAt: new Date(1713636260),
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
			404: {
				description: 'Payment request not found',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/purchase/resolve-blockchain-identifier',
		description: 'Resolves a purchase request by its blockchain identifier.',
		summary: 'Resolve a purchase request by its blockchain identifier. (READ access required)',
		tags: ['purchase'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: postPurchaseRequestSchemaInput.openapi({
							example: {
								blockchainIdentifier: 'blockchain_identifier',
								network: Network.Preprod,
								includeHistory: 'false',
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Purchase request resolved',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: postPurchaseRequestSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										id: 'cuid_v2_auto_generated',
										createdAt: new Date(1713636260),
										updatedAt: new Date(1713636260),
										blockchainIdentifier: 'blockchain_identifier',
										agentIdentifier: 'agent_identifier',
										lastCheckedAt: null,
										payByTime: null,
										submitResultTime: '0',
										unlockTime: '0',
										externalDisputeUnlockTime: '0',
										requestedById: 'requester_id',
										onChainState: null,
										collateralReturnLovelace: null,
										cooldownTime: 0,
										cooldownTimeOtherParty: 0,
										inputHash: 'input_hash',
										resultHash: '',
										NextAction: {
											requestedAction: PurchasingAction.FundsLockingRequested,
											errorType: null,
											errorNote: null,
										},
										CurrentTransaction: null,
										TransactionHistory: [],
										PaidFunds: [
											{
												unit: '',
												amount: '10000000',
											},
										],
										PaymentSource: {
											id: 'payment_source_id',
											network: Network.Preprod,
											smartContractAddress: 'address',
											policyId: 'policy_id',
										},
										SellerWallet: null,
										SmartContractWallet: null,
										metadata: null,
										WithdrawnForSeller: [],
										WithdrawnForBuyer: [],
										totalBuyerCardanoFees: 0,
										totalSellerCardanoFees: 0,
										nextActionOrOnChainStateOrResultLastChangedAt: new Date(1713636260),
										nextActionLastChangedAt: new Date(1713636260),
										onChainStateOrResultLastChangedAt: new Date(1713636260),
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
			404: {
				description: 'Purchase request not found',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});
}
