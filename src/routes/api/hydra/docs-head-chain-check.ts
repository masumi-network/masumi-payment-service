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
		summary: 'Check a Hydra head on L1 and wake its node if the head is closed. (admin access required)',
		description:
			"Reads the newest transaction that moved the head's state token. When the head is no longer Open on chain, asks the Host to start this side's node so it can contest. Disabling a head stops its node, and a stopped node cannot contest.",
		tags: TAG,
		security: [{ [apiKeyAuth.name]: [] }],
		request: { body: jsonBody(checkHeadOnChainInput, { id: 'cuid_v2_auto_generated' }) },
		responses: {
			200: successResponse('Head state on chain', checkHeadOnChainOutput, {
				isOpenOnChain: true,
				latestTxHash: 'cd'.repeat(32),
				nodeStart: null,
			}),
			401: { description: 'Unauthorized' },
			404: { description: 'Hydra head not found' },
			502: { description: 'The head state could not be read on chain' },
			503: { description: 'Independent L1 evidence not yet available' },
		},
	});
}
