import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import { checkHeadOnChainInput, checkHeadOnChainOutput } from './head/chain-check';

const TAG = ['hydra'];
const jsonBody = (schema: Parameters<typeof successResponse>[1], example: unknown) => ({
	content: { 'application/json': { schema: schema.openapi({ example }) } },
});

export function registerHydraHeadChainCheckPath({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/chain-check',
		summary: 'Check a Hydra head on L1 and set its node to match. (admin access required)',
		description:
			"Reads the newest transaction that moved the head's state token. When a disabled head is still Open on chain, asks the Host to stop this side's node, so the counterparty stops using the head. When the head is Closed on chain, asks the Host to start the node, so it can contest. A fanned-out head needs nothing.",
		tags: TAG,
		security: [{ [apiKeyAuth.name]: [] }],
		request: { body: jsonBody(checkHeadOnChainInput, { id: 'cuid_v2_auto_generated' }) },
		responses: {
			200: successResponse('Head state on chain', checkHeadOnChainOutput, {
				chainState: 'open',
				latestTxHash: 'cd'.repeat(32),
				nodeAction: 'stop',
				nodeOutcome: 'requested',
			}),
			401: { description: 'Unauthorized' },
			404: { description: 'Hydra head not found' },
			409: { description: 'Head identifier not observed yet, or no independent L1 observer configured' },
			502: { description: 'The head state could not be read on chain' },
			503: { description: 'Independent L1 evidence not yet available' },
		},
	});
}
