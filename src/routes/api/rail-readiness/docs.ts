// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR — CI regenerates
// openapi-docs.json and fails on drift.
import { railReadinessSchemaInput, railReadinessSchemaOutput } from '@/routes/api/rail-readiness/schemas';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

const railReadinessExample = {
	network: 'Preprod',
	Rails: [
		{
			rail: 'CardanoV2',
			isReady: false,
			Checks: [
				{
					id: 'cardano.payment_source',
					label: 'Payment source',
					isComplete: true,
					detail: 'Active Web3CardanoV2 source found',
				},
				{ id: 'cardano.contract_current', label: 'Current contract', isComplete: true, detail: null },
				{ id: 'cardano.rpc_provider', label: 'Blockfrost API key', isComplete: true, detail: null },
				{ id: 'cardano.admin_signatures', label: 'Admin wallets', isComplete: true, detail: null },
				{
					id: 'cardano.selling_wallet',
					label: 'Selling wallet',
					isComplete: false,
					detail: 'No selling wallet — the source cannot receive payments',
				},
				{ id: 'cardano.purchasing_wallet', label: 'Purchasing wallet', isComplete: true, detail: null },
				{ id: 'cardano.payments_enabled', label: 'Payments enabled', isComplete: true, detail: null },
			],
		},
		{
			rail: 'X402',
			isReady: true,
			Checks: [
				{ id: 'x402.enabled_chain', label: 'Enabled chain', isComplete: true, detail: 'eip155:84532' },
				{ id: 'x402.rpc_url', label: 'RPC endpoint', isComplete: true, detail: null },
				{ id: 'x402.facilitator', label: 'Facilitator', isComplete: true, detail: 'Self-hosted facilitator wallet' },
				{ id: 'x402.selling_wallet', label: 'Selling wallet', isComplete: true, detail: null },
				{
					id: 'x402.purchasing_wallet',
					label: 'Purchasing wallet',
					isComplete: false,
					detail: 'Optional — needed only to pay other agents',
				},
				{
					id: 'x402.budget',
					label: 'Spending budget',
					isComplete: false,
					detail: 'Optional — needed only to pay other agents',
				},
			],
		},
	],
};

export function registerRailReadinessPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];

	registry.registerPath({
		method: 'get',
		path: '/rail-readiness',
		description:
			'Reports whether each payment rail is actually configured well enough to take payments, so setup UIs do not have to re-derive it from several list endpoints. Each rail returns isReady plus the individual checks behind it, each with a stable id the admin UI maps its setup steps onto. isReady covers blocking checks only: for x402 that means receiving (enabled chain + RPC URL + exactly one facilitator), while purchasing wallet and budget are reported but optional. Only configuration presence is exposed — no keys, addresses or URLs.',
		summary: 'Get payment rail readiness. (read access required)',
		tags: ['rail-readiness'],
		security: secured,
		request: {
			query: railReadinessSchemaInput.openapi({ example: { network: 'Preprod' } }),
		},
		responses: {
			200: successResponse('Rail readiness', railReadinessSchemaOutput, railReadinessExample),
			401: { description: 'Unauthorized' },
		},
	});
}
