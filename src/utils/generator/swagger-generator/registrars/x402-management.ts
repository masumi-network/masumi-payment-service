import {
	analyticsSchemaInput,
	analyticsSchemaOutput,
	countSchemaOutput,
	deleteLowBalanceRuleSchemaInput,
	deleteLowBalanceRuleSchemaOutput,
	listLowBalanceRulesSchemaInput,
	listLowBalanceRulesSchemaOutput,
	lowBalanceRuleSchema,
	paymentAttemptsCountSchemaInput,
	setLowBalanceRuleSchemaInput,
	settlementsCountSchemaInput,
	updateLowBalanceRuleSchemaInput,
	updateWalletSchemaInput,
	walletBalanceSchemaInput,
	walletBalanceSchemaOutput,
	walletSchemaOutput,
	walletsCountSchemaInput,
} from '@/routes/api/x402/schemas';
import {
	deleteX402LowBalanceRuleBodyExample,
	deleteX402LowBalanceRuleResponseExample,
	listX402LowBalanceRulesResponseExample,
	setX402LowBalanceRuleBodyExample,
	updateX402LowBalanceRuleBodyExample,
	updateX402WalletBodyExample,
	x402AnalyticsBodyExample,
	x402AnalyticsResponseExample,
	x402CountResponseExample,
	x402LowBalanceRuleExample,
	x402WalletBalanceQueryExample,
	x402WalletBalanceResponseExample,
	x402WalletExample,
} from '@/routes/api/x402/examples';
import { successResponse, type SwaggerRegistrarContext } from '../shared';

// Management/observability endpoints for the x402 rail (wallet note/balance, low-balance
// rules, counts, analytics). Split from the core x402 registrar to keep each file focused.
export function registerX402ManagementPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];

	registry.registerPath({
		method: 'post',
		path: '/x402/wallets/update',
		description: 'Updates the human-readable note of a managed EVM wallet.',
		summary: 'Update a managed x402 EVM wallet. (admin access required)',
		tags: ['x402'],
		security: secured,
		request: {
			body: {
				description: 'Wallet note to set',
				content: {
					'application/json': { schema: updateWalletSchemaInput.openapi({ example: updateX402WalletBodyExample }) },
				},
			},
		},
		responses: { 200: successResponse('Managed wallet updated', walletSchemaOutput, x402WalletExample) },
	});

	registry.registerPath({
		method: 'get',
		path: '/x402/wallets/balance',
		description:
			'Reads on-chain balances (native gas plus the default token) of a managed EVM wallet across the enabled chains, or a single chain.',
		summary: 'Read managed x402 wallet balances. (admin access required)',
		tags: ['x402'],
		security: secured,
		request: { query: walletBalanceSchemaInput.openapi({ example: x402WalletBalanceQueryExample }) },
		responses: {
			200: successResponse('Managed wallet balances', walletBalanceSchemaOutput, x402WalletBalanceResponseExample),
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/x402/wallets/count',
		description: 'Counts active managed EVM wallets, optionally filtered by direction.',
		summary: 'Count managed x402 wallets. (admin access required)',
		tags: ['x402'],
		security: secured,
		request: { query: walletsCountSchemaInput },
		responses: { 200: successResponse('Managed wallet count', countSchemaOutput, x402CountResponseExample) },
	});

	registry.registerPath({
		method: 'get',
		path: '/x402/low-balance',
		description: 'Lists low-balance rules for managed EVM wallets.',
		summary: 'List x402 low-balance rules. (admin access required)',
		tags: ['x402'],
		security: secured,
		request: { query: listLowBalanceRulesSchemaInput },
		responses: {
			200: successResponse(
				'x402 low-balance rules',
				listLowBalanceRulesSchemaOutput,
				listX402LowBalanceRulesResponseExample,
			),
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/x402/low-balance',
		description:
			'Creates or updates a low-balance rule for a managed EVM wallet on a chain and asset ("native" for gas, otherwise an ERC-20 contract).',
		summary: 'Set an x402 low-balance rule. (admin access required)',
		tags: ['x402'],
		security: secured,
		request: {
			body: {
				description: 'Low-balance rule to set',
				content: {
					'application/json': {
						schema: setLowBalanceRuleSchemaInput.openapi({ example: setX402LowBalanceRuleBodyExample }),
					},
				},
			},
		},
		responses: { 200: successResponse('Low-balance rule saved', lowBalanceRuleSchema, x402LowBalanceRuleExample) },
	});

	registry.registerPath({
		method: 'patch',
		path: '/x402/low-balance',
		description: 'Updates the threshold or enabled flag of an x402 low-balance rule.',
		summary: 'Update an x402 low-balance rule. (admin access required)',
		tags: ['x402'],
		security: secured,
		request: {
			body: {
				description: 'Low-balance rule fields to update',
				content: {
					'application/json': {
						schema: updateLowBalanceRuleSchemaInput.openapi({ example: updateX402LowBalanceRuleBodyExample }),
					},
				},
			},
		},
		responses: { 200: successResponse('Low-balance rule updated', lowBalanceRuleSchema, x402LowBalanceRuleExample) },
	});

	registry.registerPath({
		method: 'delete',
		path: '/x402/low-balance',
		description: 'Deletes an x402 low-balance rule.',
		summary: 'Delete an x402 low-balance rule. (admin access required)',
		tags: ['x402'],
		security: secured,
		request: {
			body: {
				description: 'Low-balance rule to delete',
				content: {
					'application/json': {
						schema: deleteLowBalanceRuleSchemaInput.openapi({ example: deleteX402LowBalanceRuleBodyExample }),
					},
				},
			},
		},
		responses: {
			200: successResponse(
				'Low-balance rule deleted',
				deleteLowBalanceRuleSchemaOutput,
				deleteX402LowBalanceRuleResponseExample,
			),
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/x402/payments/count',
		description: 'Counts x402 payment attempts, optionally filtered by status, direction and chain.',
		summary: 'Count x402 payment attempts. (admin access required)',
		tags: ['x402'],
		security: secured,
		request: { query: paymentAttemptsCountSchemaInput },
		responses: { 200: successResponse('x402 payment attempt count', countSchemaOutput, x402CountResponseExample) },
	});

	registry.registerPath({
		method: 'get',
		path: '/x402/settlements/count',
		description: 'Counts x402 settlements, optionally filtered by chain and success.',
		summary: 'Count x402 settlements. (admin access required)',
		tags: ['x402'],
		security: secured,
		request: { query: settlementsCountSchemaInput },
		responses: { 200: successResponse('x402 settlement count', countSchemaOutput, x402CountResponseExample) },
	});

	registry.registerPath({
		method: 'post',
		path: '/x402/analytics',
		description:
			'Aggregates settled inbound (income) and signed outbound (spend) x402 flows over a window, bucketed by day and month and split by chain and asset.',
		summary: 'x402 income/spend analytics. (admin access required)',
		tags: ['x402'],
		security: secured,
		request: {
			body: {
				description: 'Analytics window and timezone',
				content: {
					'application/json': { schema: analyticsSchemaInput.openapi({ example: x402AnalyticsBodyExample }) },
				},
			},
		},
		responses: { 200: successResponse('x402 analytics', analyticsSchemaOutput, x402AnalyticsResponseExample) },
	});
}
