import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import { retireHeadInput, retireHeadOutput } from './head/retire';

const TAG = ['hydra'];
const jsonBody = (schema: Parameters<typeof successResponse>[1], example: unknown) => ({
	content: { 'application/json': { schema: schema.openapi({ example }) } },
});

export function registerHydraHeadRetirePath({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/retire',
		summary: 'Retire a Hydra head that cannot reach Final. (admin access required)',
		description:
			'Marks a closed head that fanout cannot finish as retired and frees its relation for a new head. Moves no funds: whatever is left stays on L1 behind the head script. Allowed for FanoutPossible and FanningOut heads, and for Closed heads after the contestation deadline, when L1 shows the head closed. Stores the reason, the L1 tx that holds the head output and the remaining UTxO set for a later recovery. Cannot be undone through the API.',
		tags: TAG,
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: jsonBody(retireHeadInput, {
				headId: 'cuid_v2_auto_generated',
				reason: 'An output above the fanout size limit blocks the final fanout step',
				acknowledgeStrandedFunds: true,
			}),
		},
		responses: {
			200: successResponse('Head retired', retireHeadOutput, {
				headId: 'cuid_v2_auto_generated',
				status: 'FanoutPossible',
				retiredAt: '2026-10-21T12:00:00.000Z',
				retiredHeadOutputTxHash: 'cd'.repeat(32),
				remainingUtxoCount: 1,
			}),
			400: { description: 'Invalid input, or the stranded funds were not acknowledged' },
			401: { description: 'Unauthorized' },
			404: { description: 'Hydra head not found' },
			409: {
				description:
					'Already retired, status not retirable, contestation still running, L1 shows the head open or fanned out, or the head changed meanwhile',
			},
			502: { description: 'The head state could not be read on chain' },
			503: { description: 'Independent L1 evidence or the remaining UTxO set is not available yet' },
		},
	});
}
