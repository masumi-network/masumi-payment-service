import { z } from '@/utils/zod-openapi';
import { Network, PricingType, RPCProvider } from '@/generated/prisma/client';
import {
	deleteAgentRegistrationSchemaInput,
	deleteAgentRegistrationSchemaOutput,
	queryRegistryRequestSchemaInput,
	queryRegistryRequestSchemaOutput,
	registerAgentSchemaInput,
	registerAgentSchemaOutput,
} from '@/routes/api/registry/schemas';
import { queryRegistryDiffSchemaInput } from '@/routes/api/registry/diff';
import { unregisterAgentSchemaInput, unregisterAgentSchemaOutput } from '@/routes/api/registry/deregister';
import { queryAgentFromWalletSchemaInput, queryAgentFromWalletSchemaOutput } from '@/routes/api/registry/wallet';
import {
	queryAgentByIdentifierSchemaInput,
	queryAgentByIdentifierSchemaOutput,
} from '@/routes/api/registry/agent-identifier';
import { paymentSourceSchemaInput, paymentSourceSchemaOutput } from '@/routes/api/payment-source/schemas';
import {
	paymentSourceExtendedCreateSchemaInput,
	paymentSourceExtendedCreateSchemaOutput,
	paymentSourceExtendedDeleteSchemaInput,
	paymentSourceExtendedDeleteSchemaOutput,
	paymentSourceExtendedSchemaInput,
	paymentSourceExtendedSchemaOutput,
	paymentSourceExtendedUpdateSchemaInput,
	paymentSourceExtendedUpdateSchemaOutput,
} from '@/routes/api/payment-source-extended/schemas';
import { getUTXOSchemaInput, getUTXOSchemaOutput } from '@/routes/api/utxos';
import { getRpcProviderKeysSchemaInput, getRpcProviderKeysSchemaOutput } from '@/routes/api/rpc-api-keys';
import { postPurchaseSpendingSchemaInput, postPurchaseSpendingSchemaOutput } from '@/routes/api/purchases/spending';
import { postPaymentIncomeSchemaInput, postPaymentIncomeSchemaOutput } from '@/routes/api/payments/income';
import {
	deleteWebhookSchemaInput,
	deleteWebhookSchemaOutput,
	listWebhooksSchemaInput,
	listWebhooksSchemaOutput,
	registerWebhookSchemaInput,
	registerWebhookSchemaOutput,
} from '@/routes/api/webhooks/schemas';
import {
	createPaymentSourceExtendedBodyExample,
	deletePaymentSourceExtendedBodyExample,
	listPaymentSourceExtendedQueryExample,
	listPaymentSourceExtendedResponseExample,
	paymentSourceExtendedExample,
	updatePaymentSourceExtendedBodyExample,
} from '@/routes/api/payment-source-extended/examples';
import { registryEntryExample } from '@/routes/api/registry/examples';
import { registerA2AAgentSchemaInput, registerA2AAgentSchemaOutput } from '@/routes/api/registry/a2a';
import { successResponse, type SwaggerRegistrarContext } from '../shared';

export function registerRegistrySupportPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/registry/wallet',
		description: 'Gets the agent metadata.',
		summary:
			'Fetch all agents (and their full metadata) that are registered to a specified wallet. (READ access required)',
		tags: ['registry'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryAgentFromWalletSchemaInput.openapi('test', {
				example: {
					walletVkey: 'wallet_vkey',
					network: Network.Preprod,
				},
			}),
		},
		responses: {
			200: {
				description: 'Agent metadata',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: queryAgentFromWalletSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										Assets: [
											{
												policyId: 'policy_id',
												assetName: 'asset_name',
												agentIdentifier: 'agent_identifier',
												Metadata: {
													name: 'name',
													description: 'description',
													apiBaseUrl: 'api_url',
													ExampleOutputs: [],
													Tags: ['tag1', 'tag2'],
													Capability: {
														name: 'capability_name',
														version: 'capability_version',
													},
													Legal: {
														privacyPolicy: 'privacy_policy',
														terms: 'terms',
														other: 'other',
													},
													Author: {
														name: 'author_name',
														contactEmail: 'author_contact_email',
														contactOther: 'author_contact_other',
														organization: 'author_organization',
													},
													image: 'image',
													AgentPricing: {
														pricingType: PricingType.Fixed,
														Pricing: [
															{
																unit: '',
																amount: '10000000',
															},
														],
													},
													metadataVersion: 1,
												},
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
		method: 'get',
		path: '/registry/agent-identifier',
		description: 'Gets the on-chain metadata for a specific agent by its identifier.',
		summary: 'Fetch the current metadata for a given agentIdentifier. (READ access required)',
		tags: ['registry'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryAgentByIdentifierSchemaInput.openapi({
				example: {
					agentIdentifier: 'policy_id_56_chars_hex_asset_name_hex',
					network: Network.Preprod,
				},
			}),
		},
		responses: {
			200: {
				description: 'Agent metadata retrieved successfully',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: queryAgentByIdentifierSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										policyId: 'policy_id',
										assetName: 'asset_name',
										agentIdentifier: 'policy_id_asset_name',
										Metadata: {
											name: 'Agent Name',
											description: 'Agent Description',
											apiBaseUrl: 'https://api.example.com',
											ExampleOutputs: [],
											Tags: ['tag1', 'tag2'],
											Capability: {
												name: 'capability_name',
												version: 'capability_version',
											},
											Legal: {
												privacyPolicy: 'privacy_policy',
												terms: 'terms',
												other: 'other',
											},
											Author: {
												name: 'author_name',
												contactEmail: 'author_contact_email',
												contactOther: 'author_contact_other',
												organization: 'author_organization',
											},
											image: 'ipfs://...',
											AgentPricing: {
												pricingType: PricingType.Fixed,
												Pricing: [
													{
														unit: '',
														amount: '10000000',
													},
												],
											},
											metadataVersion: 1,
										},
									},
								},
							}),
					},
				},
			},
			400: {
				description: 'Bad Request (agent identifier is not a valid hex string)',
			},
			401: {
				description: 'Unauthorized',
			},
			404: {
				description: 'Agent identifier not found or network/policyId combination not supported',
			},
			422: {
				description: 'Agent metadata is invalid or malformed',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/registry',
		description: 'Gets the agent metadata.',
		summary: 'List every agent that is recorded in the Masumi Registry. (READ access required)',
		tags: ['registry'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryRegistryRequestSchemaInput.openapi({
				example: {
					network: Network.Preprod,
					cursorId: 'cursor_id',
				},
			}),
		},
		responses: {
			200: {
				description: 'Agent metadata',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: queryRegistryRequestSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										Assets: [
											{
												error: null,
												id: 'asset_id',
												name: 'name',
												description: 'description',
												Capability: {
													name: 'capability_name',
													version: 'capability_version',
												},
												Author: {
													name: 'author_name',
													organization: 'author_organization',
													contactEmail: 'author_contact_email',
													contactOther: 'author_contact_other',
												},
												Legal: {
													privacyPolicy: 'privacy_policy',
													terms: 'terms',
													other: 'other',
												},
												state: 'RegistrationRequested',
												Tags: ['tag1', 'tag2'],
												createdAt: new Date(1713636260),
												updatedAt: new Date(1713636260),
												lastCheckedAt: new Date(1713636260),
												agentIdentifier: 'agent_identifier',
												apiBaseUrl: 'api_url',
												ExampleOutputs: [],
												AgentPricing: {
													pricingType: PricingType.Fixed,
													Pricing: [
														{
															unit: '',
															amount: '10000000',
														},
													],
												},
												SmartContractWallet: {
													walletVkey: 'wallet_vkey',
													walletAddress: 'wallet_address',
												},
												CurrentTransaction: null,
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
		method: 'get',
		path: '/registry/diff',
		description: 'Returns registry entries that changed since the provided timestamp (registrationStateLastChangedAt).',
		summary: 'Diff registry entries by state-change timestamp (READ access required)',
		tags: ['registry'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryRegistryDiffSchemaInput.openapi({
				example: {
					limit: 10,
					cursorId: 'cursor_id',
					lastUpdate: new Date(1713636260).toISOString(),
					network: Network.Preprod,
				},
			}),
		},
		responses: {
			200: {
				description: 'Agent metadata diff',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							data: queryRegistryRequestSchemaOutput,
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
		path: '/registry',
		description:
			'Registers an agent to the registry (Please note that while it it is put on-chain, the transaction is not yet finalized by the blockchain, as designed finality is only eventually reached. If you need certainty, please check status via the registry(GET) or if you require custom logic, the transaction directly using the txHash)',
		summary: 'Registers an agent to the registry (+PAY access required)',
		tags: ['registry'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: registerAgentSchemaInput.openapi({
							example: {
								network: Network.Preprod,
								ExampleOutputs: [
									{
										name: 'example_output_name',
										url: 'https://example.com/example_output',
										mimeType: 'application/json',
									},
								],
								Tags: ['tag1', 'tag2'],
								name: 'Agent Name',
								description: 'Agent Description',
								Author: {
									name: 'Author Name',
									contactEmail: 'author@example.com',
									contactOther: 'author_contact_other',
									organization: 'Author Organization',
								},
								apiBaseUrl: 'https://api.example.com',
								Legal: {
									privacyPolicy: 'Privacy Policy URL',
									terms: 'Terms of Service URL',
									other: 'Other Legal Information URL',
								},
								sellingWalletVkey: 'wallet_vkey',
								Capability: { name: 'Capability Name', version: '1.0.0' },
								AgentPricing: {
									pricingType: PricingType.Fixed,
									Pricing: [
										{
											unit: '',
											amount: '10000000',
										},
									],
								},
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Agent registered',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: registerAgentSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: registryEntryExample,
							},
						}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/registry/deregister',
		description:
			'Deregisters a agent from the specified registry (Please note that while the command is put on-chain, the transaction is not yet finalized by the blockchain, as designed finality is only eventually reached. If you need certainty, please check status via the registry(GET) or if you require custom logic, the transaction directly using the txHash)',
		summary: 'Deregisters an agent from the specified registry. (PAY access required)',
		tags: ['registry'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: unregisterAgentSchemaInput.openapi({
							example: {
								agentIdentifier: 'agentIdentifier',
								network: Network.Preprod,
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Agent deregistration requested',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: unregisterAgentSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: registryEntryExample,
							},
						}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'delete',
		path: '/registry',
		description:
			'Permanently deletes an agent registration record from the database. This action is irreversible and should only be used for registrations in specific failed or completed states.',
		summary: 'Delete an agent registration record. (admin access required)',
		tags: ['registry'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: deleteAgentRegistrationSchemaInput.openapi({
							example: {
								id: 'example_id',
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Agent registration deleted successfully',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: deleteAgentRegistrationSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: registryEntryExample,
								},
							}),
					},
				},
			},
			400: {
				description: 'Bad Request - Invalid state for deletion',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							error: z.object({ message: z.string() }),
						}),
						example: {
							status: 'error',
							error: {
								message: 'Agent registration cannot be deleted in its current state: RegistrationRequested',
							},
						},
					},
				},
			},
			401: {
				description: 'Unauthorized',
			},
			404: {
				description: 'Agent Registration not found',
				content: {
					'application/json': {
						schema: z.object({
							status: z.string(),
							error: z.object({ message: z.string() }),
						}),
						example: {
							status: 'error',
							error: { message: 'Agent Registration not found' },
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
		method: 'get',
		path: '/payment-source',
		description: 'Gets the payment source.',
		summary: 'List payment sources with their public details. (READ access required)',
		tags: ['payment-source'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: paymentSourceSchemaInput.openapi({
				example: {
					take: 10,
					cursorId: 'cursor_id',
				},
			}),
		},
		responses: {
			200: {
				description: 'Payment source status',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: paymentSourceSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: {
									PaymentSources: [
										{
											id: 'cuid_v2_auto_generated',
											createdAt: new Date(1713636260),
											updatedAt: new Date(1713636260),
											network: Network.Mainnet,
											smartContractAddress: 'address_of_the_smart_contract',
											policyId: 'policy_id',
											AdminWallets: [
												{ walletAddress: 'wallet_address', order: 0 },
												{ walletAddress: 'wallet_address', order: 1 },
												{ walletAddress: 'wallet_address', order: 2 },
											],
											feeRatePermille: 50,
											FeeReceiverNetworkWallet: {
												walletAddress: 'wallet_address',
											},
											lastCheckedAt: new Date(1713636260),
											lastIdentifierChecked: 'identifier',
											PurchasingWallets: [
												{
													collectionAddress: null,
													note: 'note',
													walletVkey: 'wallet_vkey',
													walletAddress: 'wallet_address',
													id: 'unique_cuid_v2_auto_generated',
												},
												{
													collectionAddress: 'send_refunds_to_this_address',
													note: 'note',
													walletVkey: 'wallet_vkey',
													walletAddress: 'wallet_address',
													id: 'unique_cuid_v2_auto_generated',
												},
											],
											SellingWallets: [
												{
													collectionAddress: 'null_will_use_selling_wallet_as_revenue_address',
													note: 'note',
													walletVkey: 'wallet_vkey',
													walletAddress: 'wallet_address',
													id: 'unique_cuid_v2_auto_generated',
												},
												{
													collectionAddress: 'send_revenue_to_this_address',
													note: 'note',
													walletVkey: 'wallet_vkey',
													walletAddress: 'wallet_address',
													id: 'unique_cuid_v2_auto_generated',
												},
											],
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
		method: 'get',
		path: '/payment-source-extended',
		description: 'Gets the payment contracts including the status.',
		summary:
			'List payment sources with their public details augmented with internal configuration and sync status information. (admin access required)',
		tags: ['payment-source'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: paymentSourceExtendedSchemaInput.openapi({ example: listPaymentSourceExtendedQueryExample }),
		},
		responses: {
			200: {
				description: 'Payment source status',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: paymentSourceExtendedSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: listPaymentSourceExtendedResponseExample,
								},
							}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/payment-source-extended',
		description: 'Creates a payment source.',
		summary: 'Create a new payment source. (+ADMIN access required)',
		tags: ['payment-source'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: paymentSourceExtendedCreateSchemaInput.openapi({ example: createPaymentSourceExtendedBodyExample }),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Payment source created',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: paymentSourceExtendedCreateSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: paymentSourceExtendedExample,
								},
							}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'patch',
		path: '/payment-source-extended',
		description: 'Updates a payment source.',
		summary: 'Update an existing payment source. (+ADMIN access required)',
		tags: ['payment-source'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: paymentSourceExtendedUpdateSchemaInput.openapi({ example: updatePaymentSourceExtendedBodyExample }),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Payment contract updated',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: paymentSourceExtendedUpdateSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: paymentSourceExtendedExample,
								},
							}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'delete',
		path: '/payment-source-extended',
		description: 'Deletes a payment source. WARNING will also delete all associated wallets and transactions.',
		summary: 'Delete an existing payment source. (+ADMIN access required)',
		tags: ['payment-source'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: paymentSourceExtendedDeleteSchemaInput.openapi({ example: deletePaymentSourceExtendedBodyExample }),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Payment source deleted',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: paymentSourceExtendedDeleteSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: paymentSourceExtendedExample,
								},
							}),
					},
				},
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/utxos',
		description: 'Gets UTXOs (internal)',
		summary:
			'Helper endpoint that lets you ask the payment service for the current UTXOs sitting at a particular Cardano address. (READ access required)',
		tags: ['utxos'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: getUTXOSchemaInput.openapi({
				example: {
					network: Network.Preprod,
					address: 'addr1qx2ej34k567890',
					count: 10,
					page: 1,
					order: 'Desc',
				},
			}),
		},
		responses: {
			200: {
				description: 'UTXOs',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: getUTXOSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: {
									Utxos: [
										{
											txHash: 'tx_hash',
											address: 'addr1qx2ej34k567890',
											Amounts: [
												{
													unit: '',
													quantity: 10000000,
												},
											],
											outputIndex: 1,
											block: '1',
											dataHash: 'data_hash',
											inlineDatum: 'inline_datum',
											referenceScriptHash: 'reference_script_hash',
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
		method: 'get',
		path: '/rpc-api-keys',
		description: 'Gets rpc api keys, currently only blockfrost is supported (internal)',
		summary: 'List Blockfrost API keys. (admin access required)',
		tags: ['rpc-api-keys'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: getRpcProviderKeysSchemaInput.openapi({
				example: {
					cursorId: 'unique_cuid_v2',
					limit: 50,
				},
			}),
		},
		responses: {
			200: successResponse('Blockfrost keys', getRpcProviderKeysSchemaOutput, {
				RpcProviderKeys: [
					{
						network: Network.Preprod,
						id: 'unique_cuid_v2',
						rpcProviderApiKey: 'blockfrost_api_key',
						rpcProvider: RPCProvider.Blockfrost,
						createdAt: new Date(1713636260),
						updatedAt: new Date(1713636260),
					},
				],
			}),
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
		path: '/purchase/spending',
		description:
			'Get agent spending, fees, and volume analytics for Purchase Request transactions only, over specified time periods.',
		summary: 'Get agent purchase spending analytics. (READ access required)',
		tags: ['purchase-spending'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: postPurchaseSpendingSchemaInput.openapi({
							example: {
								agentIdentifier: 'example_agent_identifier_asset_id',
								startDate: '2024-01-01',
								endDate: '2024-01-31',
								network: Network.Preprod,
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Agent purchase spending analytics',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: postPurchaseSpendingSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										agentIdentifier: 'example_agent_identifier_asset_id',
										periodStart: new Date('2024-01-01T00:00:00.000Z'),
										periodEnd: new Date('2024-01-31T23:59:59.000Z'),
										totalTransactions: 25,
										TotalSpend: {
											Units: [
												{
													unit: '',
													amount: 47500000,
												},
											],
											blockchainFees: 2500000,
										},
										TotalRefunded: {
											Units: [
												{
													unit: '',
													amount: 2500000,
												},
											],
											blockchainFees: 100000,
										},
										TotalPending: {
											Units: [],
											blockchainFees: 0,
										},
										DailySpend: [
											{
												day: 15,
												month: 9,
												year: 2024,
												Units: [
													{
														unit: '',
														amount: 2100000,
													},
												],
												blockchainFees: 100000,
											},
										],
										DailyRefunded: [
											{
												day: 15,
												month: 9,
												year: 2024,
												Units: [
													{
														unit: '',
														amount: 0,
													},
												],
												blockchainFees: 0,
											},
										],
										DailyPending: [
											{
												day: 15,
												month: 9,
												year: 2024,
												Units: [
													{
														unit: '',
														amount: 0,
													},
												],
												blockchainFees: 0,
											},
										],
										MonthlySpend: [
											{
												month: 9,
												year: 2024,
												Units: [
													{
														unit: '',
														amount: 2100000,
													},
												],
												blockchainFees: 100000,
											},
										],
										MonthlyRefunded: [
											{
												month: 9,
												year: 2024,
												Units: [],
												blockchainFees: 0,
											},
										],
										MonthlyPending: [
											{
												month: 9,
												year: 2024,
												Units: [],
												blockchainFees: 0,
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
			404: {
				description: 'Agent not found or no spendings data available',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/payment/income',
		description: 'Get payment income analytics for Payment Request transactions, over specified time periods.',
		summary: 'Get payment income analytics. (READ access required)',
		tags: ['payment-income'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: postPaymentIncomeSchemaInput.openapi({
							example: {
								agentIdentifier: 'example_agent_identifier_asset_id',
								startDate: '2024-01-01',
								endDate: '2024-01-31',
								network: Network.Preprod,
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Agent payment income analytics',
				content: {
					'application/json': {
						schema: z
							.object({
								status: z.string(),
								data: postPaymentIncomeSchemaOutput,
							})
							.openapi({
								example: {
									status: 'Success',
									data: {
										agentIdentifier: 'example_agent_identifier_asset_id',
										periodStart: new Date('2024-01-01T00:00:00.000Z'),
										periodEnd: new Date('2024-01-31T23:59:59.000Z'),
										totalTransactions: 25,
										TotalIncome: {
											Units: [{ unit: '', amount: 45000000 }],
											blockchainFees: 2500000,
										},
										TotalRefunded: {
											Units: [{ unit: '', amount: 5000000 }],
											blockchainFees: 400000,
										},
										TotalPending: {
											Units: [{ unit: '', amount: 2000000 }],
											blockchainFees: 100000,
										},
										DailyIncome: [
											{
												day: 10,
												month: 1,
												year: 2024,
												Units: [{ unit: '', amount: 2000000 }],
												blockchainFees: 100000,
											},
										],
										DailyRefunded: [
											{
												day: 12,
												month: 1,
												year: 2024,
												Units: [{ unit: '', amount: 500000 }],
												blockchainFees: 20000,
											},
										],
										DailyPending: [
											{
												day: 15,
												month: 1,
												year: 2024,
												Units: [{ unit: '', amount: 500000 }],
												blockchainFees: 0,
											},
										],
										MonthlyIncome: [
											{
												month: 1,
												year: 2024,
												Units: [{ unit: '', amount: 45000000 }],
												blockchainFees: 2500000,
											},
										],
										MonthlyRefunded: [
											{
												month: 1,
												year: 2024,
												Units: [{ unit: '', amount: 5000000 }],
												blockchainFees: 400000,
											},
										],
										MonthlyPending: [
											{
												month: 1,
												year: 2024,
												Units: [{ unit: '', amount: 2000000 }],
												blockchainFees: 100000,
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
			404: {
				description: 'Agent not found or no income data available',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/webhooks',
		description: 'List webhook endpoints',
		summary: 'List all webhook endpoints registered by your API key. (pay-authenticated access required)',
		tags: ['webhooks'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: listWebhooksSchemaInput.openapi({
				example: {
					paymentSourceId: 'payment_source_id_optional',
				},
			}),
		},
		responses: {
			200: {
				description: 'List of webhook endpoints',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: listWebhooksSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: {
									Webhooks: [
										{
											id: 'webhook_endpoint_id',
											url: 'https://your-server.com/webhook',
											name: 'My Webhook',
											Events: ['PURCHASE_ON_CHAIN_STATUS_CHANGED', 'PAYMENT_ON_ERROR'],
											isActive: true,
											createdAt: new Date(1713636260),
											updatedAt: new Date(1713636260),
											paymentSourceId: null,
											failureCount: 0,
											lastSuccessAt: new Date(1713636260),
											disabledAt: null,
											CreatedBy: {
												apiKeyId: 'api_key_id',
												apiKeyToken: 'masked_token',
											},
										},
									],
								},
							},
						}),
					},
				},
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
		path: '/webhooks',
		description: 'Register a new webhook endpoint',
		summary: 'Register a new webhook endpoint to receive event notifications. (pay-authenticated access required)',
		tags: ['webhooks'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Webhook registration details',
				content: {
					'application/json': {
						schema: registerWebhookSchemaInput.openapi({
							example: {
								url: 'https://your-server.com/webhook',
								authToken: 'your-webhook-secret-token',
								Events: ['PURCHASE_ON_CHAIN_STATUS_CHANGED', 'PAYMENT_ON_ERROR'],
								name: 'My Payment Webhook',
								paymentSourceId: 'payment_source_id_optional',
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Webhook endpoint registered successfully',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: registerWebhookSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: {
									id: 'webhook_endpoint_id',
									url: 'https://your-server.com/webhook',
									name: 'My Payment Webhook',
									Events: ['PURCHASE_ON_CHAIN_STATUS_CHANGED', 'PAYMENT_ON_ERROR'],
									isActive: true,
									createdAt: new Date(1713636260),
									paymentSourceId: null,
								},
							},
						}),
					},
				},
			},
			400: {
				description: 'Bad Request (invalid webhook URL or configuration)',
			},
			401: {
				description: 'Unauthorized',
			},
			404: {
				description: 'Payment source not found',
			},
			409: {
				description: 'Webhook URL already registered for this payment source',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'delete',
		path: '/webhooks',
		description: 'Delete a webhook endpoint',
		summary:
			'Delete an existing webhook endpoint. Only the creator or admin can delete a webhook. (pay-authenticated access required)',
		tags: ['webhooks'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Webhook deletion request',
				content: {
					'application/json': {
						schema: deleteWebhookSchemaInput.openapi({
							example: {
								webhookId: 'webhook_endpoint_id',
							},
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Webhook endpoint deleted successfully',
				content: {
					'application/json': {
						schema: z.object({ status: z.string(), data: deleteWebhookSchemaOutput }).openapi({
							example: {
								status: 'Success',
								data: {
									id: 'webhook_endpoint_id',
									url: 'https://your-server.com/webhook',
									name: 'My Payment Webhook',
									deletedAt: new Date(1713636260),
								},
							},
						}),
					},
				},
			},
			401: {
				description: 'Unauthorized',
			},
			403: {
				description: 'Forbidden (only creator or admin can delete)',
			},
			404: {
				description: 'Webhook endpoint not found',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/registry/a2a',
		description:
			'Registers an A2A (Agent-to-Agent) agent in the Masumi Registry using MIP-002-A2A metadata (version 2). Fetches and validates the Agent Card unless skipAgentCardValidation is set.',
		summary: 'Register an A2A agent in the Masumi Registry. (PAY access required)',
		tags: ['registry'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: registerA2AAgentSchemaInput.openapi({
							example: {
								network: Network.Preprod,
								sellingWalletVkey: 'wallet_vkey',
								name: 'My A2A Agent',
								apiBaseUrl: 'https://api.example.com',
								agentCardUrl: 'https://api.example.com/.well-known/agent-card.json',
								a2aProtocolVersions: ['0.2.5'],
								description: 'An A2A-capable AI agent',
								Tags: ['a2a', 'agent'],
								skipAgentCardValidation: false,
							},
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse(
				'A2A agent registered',
				registerA2AAgentSchemaOutput,
				{
					...registryEntryExample,
					metadataVersion: 2,
					agentCardUrl: 'https://api.example.com/.well-known/agent-card.json',
					a2aProtocolVersions: ['0.2.5'],
					Author: { name: '', contactEmail: null, contactOther: null, organization: null },
					AgentPricing: { pricingType: PricingType.Free },
				},
			),
			400: {
				description: 'Bad Request (invalid input or Agent Card validation failed)',
			},
			401: {
				description: 'Unauthorized',
			},
			404: {
				description: 'Wallet not found',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});
}
