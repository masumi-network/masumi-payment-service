import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import { fanoutRemainingOutput, partialFanoutHeadInput, partialFanoutHeadOutput } from './head/partial-fanout';
import { lifecycleInput } from './head/lifecycle';

const TAG = ['hydra'];
const jsonBody = (schema: Parameters<typeof successResponse>[1], example: unknown) => ({
	content: { 'application/json': { schema: schema.openapi({ example }) } },
});

export function registerHydraHeadPartialFanoutPath({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/hydra/head/partial-fanout',
		summary: 'List what a closed Hydra head can still fan out. (admin access required)',
		description:
			'Lists the in-head outputs a partial fanout can select now, read from the node head state: the set the node checks a selection against. fanoutMode says whether the node waits for a selection. Read-only.',
		tags: TAG,
		security: [{ [apiKeyAuth.name]: [] }],
		request: { query: lifecycleInput.openapi({ example: { headId: 'cuid_v2_auto_generated' } }) },
		responses: {
			200: successResponse('Outputs left to fan out', fanoutRemainingOutput, {
				headId: 'cuid_v2_auto_generated',
				status: 'FanningOut',
				fanoutMode: 'AwaitingSelection',
				outputs: [{ reference: `${'ab'.repeat(32)}#0`, address: 'addr_test1vz...', lovelace: '2000000' }],
			}),
			401: { description: 'Unauthorized' },
			404: { description: 'Hydra head not found' },
			409: { description: 'Status not FanoutPossible or FanningOut, or the node does not hold the head as closed' },
			502: { description: 'No connection to the head, or the node returned an unreadable head state' },
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/partial-fanout',
		summary: 'Fan out part of a closed Hydra head. (admin access required)',
		description:
			'Asks the node to fan out the selected in-head outputs in one or more L1 steps. Allowed for FanoutPossible and FanningOut heads. Selecting everything that remains ends in the final step and Final. Once a step lands the head is FanningOut, and only this endpoint can continue the fanout. Use it to move every output that fits out of a head that one oversized output keeps from reaching Final, then retire the head.',
		tags: TAG,
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: jsonBody(partialFanoutHeadInput, {
				headId: 'cuid_v2_auto_generated',
				outputRefs: [`${'ab'.repeat(32)}#0`],
			}),
		},
		responses: {
			200: successResponse('Partial fanout step result', partialFanoutHeadOutput, {
				headId: 'cuid_v2_auto_generated',
				status: 'FanningOut',
				selectedCount: 1,
			}),
			400: { description: 'Invalid input' },
			401: { description: 'Unauthorized' },
			404: { description: 'Hydra head not found' },
			409: {
				description:
					'Head disabled, status not FanoutPossible or FanningOut, an output is not in the head, or the node is still fanning out on its own and replaceInProgressSelection is not set',
			},
			502: { description: 'No connection to the head, or the node returned an unreadable head state' },
		},
	});
}
