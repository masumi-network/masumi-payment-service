import {
	budgetSchema,
	createPaymentSchemaInput,
	createPaymentSchemaOutput,
	createWalletSchemaInput,
	createWalletSchemaOutput,
	deleteWalletSchemaInput,
	deleteWalletSchemaOutput,
	listBudgetSchemaInput,
	listBudgetSchemaOutput,
	listNetworksSchemaInput,
	listNetworksSchemaOutput,
	listPaymentAttemptsSchemaInput,
	listPaymentAttemptsSchemaOutput,
	listSettlementsSchemaInput,
	listSettlementsSchemaOutput,
	listWalletsSchemaInput,
	listWalletsSchemaOutput,
	setBudgetSchemaInput,
	settleSchemaOutput,
	upsertNetworkSchemaInput,
	verifySchemaOutput,
	verifySettleSchemaInput,
	x402NetworkSchema,
} from '@/routes/api/x402/schemas';
import {
	createX402PaymentBodyExample,
	createX402PaymentResponseExample,
	createX402WalletBodyExample,
	createX402WalletResponseExample,
	deleteX402WalletBodyExample,
	deleteX402WalletResponseExample,
	listX402BudgetsQueryExample,
	listX402BudgetsResponseExample,
	listX402NetworksResponseExample,
	listX402PaymentAttemptsQueryExample,
	listX402PaymentAttemptsResponseExample,
	listX402SettlementsQueryExample,
	listX402SettlementsResponseExample,
	listX402WalletsQueryExample,
	listX402WalletsResponseExample,
	setX402BudgetBodyExample,
	settleX402ResponseExample,
	upsertX402NetworkBodyExample,
	verifyX402BodyExample,
	verifyX402ResponseExample,
	x402BudgetExample,
	x402NetworkExample,
} from '@/routes/api/x402/examples';
import { successResponse, type SwaggerRegistrarContext } from '../shared';

export function registerX402Paths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/x402/networks',
		description: 'Lists the EVM chains configured for the standard x402 payment rail.',
		summary: 'List configured x402 EVM chains. (admin access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: { query: listNetworksSchemaInput },
		responses: {
			200: successResponse('Configured x402 EVM chains', listNetworksSchemaOutput, listX402NetworksResponseExample),
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/x402/networks',
		description: 'Creates or updates an EVM chain configuration, keyed by its CAIP-2 id.',
		summary: 'Create or update an x402 EVM chain. (admin access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Chain configuration to upsert',
				content: {
					'application/json': {
						schema: upsertNetworkSchemaInput.openapi({ example: upsertX402NetworkBodyExample }),
					},
				},
			},
		},
		responses: { 200: successResponse('Chain configuration saved', x402NetworkSchema, x402NetworkExample) },
	});

	registry.registerPath({
		method: 'get',
		path: '/x402/wallets',
		description: 'Lists the managed EVM wallets used to fund x402 payments and settle inbound payments.',
		summary: 'List managed x402 EVM wallets. (admin access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: listWalletsSchemaInput.openapi({ example: listX402WalletsQueryExample }),
		},
		responses: {
			200: successResponse('Managed x402 EVM wallets', listWalletsSchemaOutput, listX402WalletsResponseExample),
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/x402/wallets',
		description:
			'Creates a managed EVM wallet. A new private key is generated when none is supplied; the key is stored encrypted and never returned.',
		summary: 'Create a managed x402 EVM wallet. (admin access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Optional private key to import',
				content: {
					'application/json': {
						schema: createWalletSchemaInput.openapi({ example: createX402WalletBodyExample }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Managed wallet created', createWalletSchemaOutput, createX402WalletResponseExample),
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/x402/wallets/delete',
		description:
			'Retires a managed EVM wallet: soft-deletes it, disables its budgets, and detaches it from any chain it facilitates so a compromised key can no longer sign or settle.',
		summary: 'Retire a managed x402 EVM wallet. (admin access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Managed wallet to retire',
				content: {
					'application/json': {
						schema: deleteWalletSchemaInput.openapi({ example: deleteX402WalletBodyExample }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Managed wallet retired', deleteWalletSchemaOutput, deleteX402WalletResponseExample),
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/x402/budgets',
		description: 'Lists per-API-key spend budgets for managed x402 wallets, optionally filtered by API key.',
		summary: 'List x402 wallet budgets. (admin access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: listBudgetSchemaInput.openapi({ example: listX402BudgetsQueryExample }),
		},
		responses: {
			200: successResponse('x402 wallet budgets', listBudgetSchemaOutput, listX402BudgetsResponseExample),
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/x402/budgets',
		description:
			'Sets the remaining spend budget for an (API key, managed wallet, chain, asset) tuple. Replaces the remaining amount.',
		summary: 'Set an x402 wallet budget. (admin access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Budget to set',
				content: {
					'application/json': {
						schema: setBudgetSchemaInput.openapi({ example: setX402BudgetBodyExample }),
					},
				},
			},
		},
		responses: { 200: successResponse('Budget saved', budgetSchema, x402BudgetExample) },
	});

	registry.registerPath({
		method: 'post',
		path: '/x402/verify',
		description:
			'Verifies a buyer x402 payment payload against a registered resource without settling it, so a resource server can check a payment before serving content.',
		summary: 'Verify an inbound x402 payment. (pay access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'The registered supported payment source id and the buyer payment payload to verify',
				content: {
					'application/json': {
						schema: verifySettleSchemaInput.openapi({ example: verifyX402BodyExample }),
					},
				},
			},
		},
		responses: { 200: successResponse('x402 verification result', verifySchemaOutput, verifyX402ResponseExample) },
	});

	registry.registerPath({
		method: 'post',
		path: '/x402/settle',
		description:
			'Settles a buyer x402 payment payload on-chain for a registered resource and records the settlement. Idempotent per payment payload hash.',
		summary: 'Settle an inbound x402 payment on-chain. (pay access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'The registered supported payment source id and the buyer payment payload to settle',
				content: {
					'application/json': {
						schema: verifySettleSchemaInput.openapi({ example: verifyX402BodyExample }),
					},
				},
			},
		},
		responses: { 200: successResponse('x402 settlement result', settleSchemaOutput, settleX402ResponseExample) },
	});

	registry.registerPath({
		method: 'post',
		path: '/x402/pay',
		description:
			'Signs a payment for a forwarded 402 using a managed EVM wallet, charged against the caller budget. Returns the X-PAYMENT header for the caller to send with its own retried request; this service never fetches the resource itself.',
		summary: 'Sign a payment for a forwarded 402. (pay access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'The 402 Payment Required response the buyer received',
				content: {
					'application/json': {
						schema: createPaymentSchemaInput.openapi({ example: createX402PaymentBodyExample }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Signed x402 payment', createPaymentSchemaOutput, createX402PaymentResponseExample),
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/x402/payments',
		description:
			'Lists x402 payment attempts (inbound verify/settle and outbound payments), newest first, with their settlement result.',
		summary: 'List x402 payment attempts. (admin access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: listPaymentAttemptsSchemaInput.openapi({ example: listX402PaymentAttemptsQueryExample }),
		},
		responses: {
			200: successResponse(
				'x402 payment attempts',
				listPaymentAttemptsSchemaOutput,
				listX402PaymentAttemptsResponseExample,
			),
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/x402/settlements',
		description: 'Lists x402 on-chain settlements, newest first.',
		summary: 'List x402 settlements. (admin access required)',
		tags: ['x402'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: listSettlementsSchemaInput.openapi({ example: listX402SettlementsQueryExample }),
		},
		responses: {
			200: successResponse('x402 settlements', listSettlementsSchemaOutput, listX402SettlementsResponseExample),
		},
	});
}
